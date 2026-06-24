// /api/chat.js
// Vercel Serverless Function — proxies streaming requests to Gemini.
// The Gemini API key lives ONLY here (as an environment variable),
// never in the browser, never in the HTML/JS shipped to the client.

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing GEMINI_API_KEY env var.' } });
    return;
  }
  // NOTE: deliberately not validating the key's shape/prefix here.
  // Google has changed key formats before (AIza... -> AQ....) without
  // notice, and the Gemini API itself is the only reliable judge of
  // whether a key is valid. Let the request through and let Gemini's
  // own response (200 vs 4xx) be the source of truth.

  // OPTIONAL: lightweight same-origin check.
  // This is NOT a security boundary (headers can be spoofed by non-browser
  // clients), it just stops casual hot-linking from other sites.
  // Set ALLOWED_ORIGIN in Vercel env vars to your real domain to enable it.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin) {
    const origin = req.headers.origin || req.headers.referer || '';
    if (!origin.startsWith(allowedOrigin)) {
      res.status(403).json({ error: { message: 'Forbidden origin.' } });
      return;
    }
  }

  const { system_instruction, contents, generationConfig } = req.body || {};
  if (!contents) {
    res.status(400).json({ error: { message: 'Missing "contents" in request body.' } });
    return;
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

  try {
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction,
        contents,
        generationConfig: generationConfig || { maxOutputTokens: 1024, temperature: 0.3 }
      })
    });

    if (!geminiRes.ok) {
      // Forward Gemini's error status/body so the frontend's existing
      // error parser (parseGeminiError) keeps working unmodified.
      let body;
      try { body = await geminiRes.json(); } catch (e) { body = {}; }
      // Log the real status + message to Vercel's Runtime Logs so we can
      // diagnose the actual cause instead of guessing from the generic
      // frontend error bubble.
      console.error('Gemini API error', {
        status: geminiRes.status,
        statusText: geminiRes.statusText,
        body: JSON.stringify(body)
      });
      res.status(geminiRes.status).json(body);
      return;
    }

    // Stream the SSE response straight through to the browser.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();

  } catch (err) {
    console.error('Proxy request failed', { message: err.message, stack: err.stack });
    res.status(500).json({ error: { message: err.message || 'Proxy request failed.' } });
  }
}

// Vercel config: keep default body parsing (JSON), no edge runtime needed.
export const config = {
  api: {
    bodyParser: true
  }
};
