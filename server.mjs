import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/voice-session.js', ['voice-session.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw fail(415, 'Expected application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw fail(413, 'Request exceeds 64 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Invalid JSON.'); }
}

// No OpenAI SDK or build step is required. fetchImpl is injectable for offline tests.
export function createApp({ apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
  fetchImpl = fetch, now = Date.now } = {}) {
  const nonce = randomBytes(32).toString('hex');
  let windowStart = now();
  let starts = 0;
  let pending = 0;
  const server = createServer(async (req, res) => {
    const address = server.address();
    const host = `localhost:${address.port}`;
    const origin = `http://${host}`;
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Reject DNS rebinding and cross-site requests. This is a local, single-user app.
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)
        || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Use the localhost URL printed by the server.');
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && path === '/api/config') {
        return json(200, { model, voices: VOICES, defaultVoice: 'shimmer', nonce, configured: Boolean(apiKey) });
      }
      if (path === '/api/session' && req.method === 'POST') {
        const supplied = Buffer.from(req.headers['x-session-nonce'] || '');
        const expected = Buffer.from(nonce);
        if (req.headers.origin !== origin || supplied.length !== expected.length
          || !timingSafeEqual(supplied, expected)) throw fail(403, 'Reload the page and try again.');
        if (!apiKey) throw fail(503, 'Set OPENAI_API_KEY in .env and restart the server.');
        const body = await readJson(req);
        if (!body || typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')
          || !body.sdp.includes('m=audio') || !VOICES.includes(body.voice)
          || typeof body.instructions !== 'string' || body.instructions.length > 4000) {
          throw fail(400, 'Supply an audio SDP offer, an available voice and instructions of at most 4000 characters.');
        }
        if (now() - windowStart >= 60000) { windowStart = now(); starts = 0; }
        if (starts >= 10 || pending >= 2) throw fail(429, 'Too many connection attempts. Wait one minute.');
        starts += 1;
        pending += 1;
        try {
          const form = new FormData();
          form.set('sdp', body.sdp);
          form.set('session', JSON.stringify({
            type: 'realtime', model, output_modalities: ['audio'],
            instructions: body.instructions || 'Speak clearly, calmly and naturally. Use concise Australian English.',
            audio: {
              input: { turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } },
              output: { voice: body.voice },
            },
          }));
          const upstream = await fetchImpl('https://api.openai.com/v1/realtime/calls', {
            method: 'POST', headers: { Authorization: `Bearer ${apiKey}` },
            body: form, signal: AbortSignal.timeout(25000),
          });
          // Never forward upstream error bodies, headers, credentials or SDP to logs.
          if (!upstream.ok) {
            const hints = {
              400: 'OpenAI rejected the session configuration. Check the model and current API documentation.',
              401: 'OpenAI authentication failed. Check the server API key.',
              403: 'The API project does not have permission for this model.',
              404: 'The configured Realtime model or endpoint is unavailable.',
              429: 'OpenAI rate or quota limit reached. Check API project usage and billing.',
            };
            await upstream.body?.cancel();
            throw fail(502, hints[upstream.status] || 'OpenAI could not create the voice session. Try again later.');
          }
          // The Realtime calls reference returns raw SDP. Also accept the documented JSON envelope.
          const raw = await upstream.text();
          let sdp = raw;
          if (upstream.headers.get('content-type')?.includes('application/json')) {
            try { sdp = JSON.parse(raw).transport?.sdp; } catch { sdp = null; }
          }
          if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) throw fail(502, 'OpenAI returned an invalid SDP answer.');
          return json(200, { sdp });
        } finally { pending -= 1; }
      }
      const asset = assets.get(path);
      if (asset && req.method === 'GET') {
        const data = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1] });
        return res.end(data);
      }
      json(404, { error: 'Not found.' });
    } catch (error) {
      const timeout = error.name === 'TimeoutError';
      json(error.status || (timeout ? 504 : 502), {
        error: error.status ? error.message : timeout ? 'Voice connection timed out. Try again.' : 'Unable to complete the request. Check network access and retry.',
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`Voice prototype: http://localhost:${port}`);
    if (!process.env.OPENAI_API_KEY) console.log('Set OPENAI_API_KEY in .env to enable live connections.');
  });
}
