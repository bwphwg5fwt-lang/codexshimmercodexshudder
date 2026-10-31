import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

// Use node:http so Host-header rejection is exercised without fetch normalising it.
function localFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method || 'GET', headers: options.headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
import { createApp } from '../server.mjs';

const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
async function fixture(t, options = {}) {
  const calls = [];
  const server = createApp({ apiKey: 'server-test-secret', fetchImpl: async (...args) => {
    calls.push(args);
    return new Response(offer, { status: 201, headers: { 'Content-Type': 'application/sdp' } });
  }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = `localhost:${server.address().port}`;
  const get = path => localFetch(base + path, { headers: { Host: host } });
  const config = await (await get('/api/config')).json();
  const post = (body = {}, headers = {}) => localFetch(base + '/api/session', {
    method: 'POST', headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'X-Session-Nonce': config.nonce, ...headers },
    body: JSON.stringify({ sdp: offer, voice: 'shimmer', instructions: 'Speak calmly.', ...body }),
  });
  return { calls, base, host, get, post, config };
}

test('serves only allowlisted browser assets and never credentials', async t => {
  const f = await fixture(t);
  assert.equal(f.config.configured, true);
  assert.ok(!JSON.stringify(f.config).includes('server-test-secret'));
  for (const path of ['/', '/app.js', '/voice-session.js', '/style.css']) {
    const res = await f.get(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  for (const path of ['/.env', '/server.mjs', '/package.json', '/unknown']) assert.equal((await f.get(path)).status, 404);
});

test('exchanges SDP with server-only bearer authentication and fixed session schema', async t => {
  const f = await fixture(t);
  const res = await f.post({ model: 'browser-cannot-override-this', apiKey: 'ignored' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sdp: offer });
  const [url, request] = f.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(request.headers.Authorization, 'Bearer server-test-secret');
  assert.equal(request.body.get('sdp'), offer);
  const session = JSON.parse(request.body.get('session'));
  assert.equal(session.type, 'realtime');
  assert.equal(session.model, 'gpt-realtime-2.1');
  assert.equal(session.audio.output.voice, 'shimmer');
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(session.audio.input.format, undefined);
});

test('accepts the JSON SDP response envelope', async t => {
  const f = await fixture(t, { fetchImpl: async () => Response.json({ session: { id: 'opaque' }, transport: { sdp: offer } }) });
  assert.deepEqual(await (await f.post()).json(), { sdp: offer });
});

test('blocks missing nonce, cross-site origin and forged host before upstream calls', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'X-Session-Nonce': '' }, { Origin: 'https://example.org' }, { Host: 'attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.post({}, headers)).status, 403);
  }
  assert.equal(f.calls.length, 0);
});

test('validates bodies, voices, instructions, content type and request size', async t => {
  const f = await fixture(t);
  for (const body of [{ sdp: '' }, { voice: 'native-ios' }, { instructions: 42 }, { instructions: 'x'.repeat(4001) }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal((await f.post({}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post({ sdp: 'v=0' + 'x'.repeat(66000) })).status, 413);
  const malformed = await localFetch(f.base + '/api/session', { method: 'POST', headers: { Host: f.host, Origin: `http://${f.host}`, 'Content-Type': 'application/json', 'X-Session-Nonce': f.config.nonce }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(f.calls.length, 0);
});

test('missing key is reported without making an API call', async t => {
  const f = await fixture(t, { apiKey: '' });
  assert.equal(f.config.configured, false);
  assert.equal((await f.post()).status, 503);
  assert.equal(f.calls.length, 0);
});

test('upstream failures and invalid answers are sanitised', async t => {
  for (const fetchImpl of [
    async () => new Response('sensitive provider detail server-test-secret', { status: 401 }),
    async () => new Response('not SDP'),
    async () => { throw new Error('sensitive network detail server-test-secret'); },
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
  ]) {
    const f = await fixture(t, { fetchImpl });
    const res = await f.post();
    assert.ok([502, 504].includes(res.status));
    const body = await res.text();
    assert.ok(!body.includes('server-test-secret'));
    assert.ok(!body.includes('sensitive'));
  }
});

test('connection rate is capped and resets after one minute', async t => {
  let time = 0;
  const f = await fixture(t, { now: () => time });
  for (let i = 0; i < 10; i++) assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 429);
  assert.equal(f.calls.length, 10);
  time = 60000;
  assert.equal((await f.post()).status, 200);
});
