import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../public/voice-session.js';

const options = { voice: 'shimmer', instructions: 'Speak calmly.', nonce: 'test-nonce' };
function fixture(overrides = {}) {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = { close() { this.closed = true; } };
  const pc = {
    localDescription: { sdp: 'v=0\r\nm=audio' },
    addTrack(t, s) { this.added = [t, s]; },
    createDataChannel() { return channel; },
    async createOffer() { return this.localDescription; },
    async setLocalDescription() {},
    async setRemoteDescription(description) { this.remote = description; },
    close() { this.closed = true; },
  };
  const audio = { srcObject: null, pause() {}, play: async () => {} };
  const events = [];
  const statuses = [];
  const requests = [];
  const session = new VoiceSession({ audio, peerFactory: () => pc, getUserMedia: async () => stream,
    fetchImpl: async (...args) => { requests.push(args); return Response.json({ sdp: 'v=0 answer' }); },
    onEvent: e => events.push(e), onStatus: s => statuses.push(s), ...overrides });
  return { session, track, stream, channel, pc, audio, events, statuses, requests };
}

test('connects original audio tracks, exchanges SDP, handles events, mute and cleanup', async () => {
  const f = fixture();
  try {
    await f.session.connect(options);
    assert.deepEqual(f.pc.added, [f.track, f.stream]);
    assert.deepEqual(f.pc.remote, { type: 'answer', sdp: 'v=0 answer' });
    assert.equal(f.requests[0][0], '/api/session');
    assert.equal(f.requests[0][1].headers['X-Session-Nonce'], 'test-nonce');
    f.pc.ontrack({ streams: [f.stream] });
    assert.equal(f.audio.srcObject, f.stream);
    f.channel.onmessage({ data: '{"type":"session.created"}' });
    f.channel.onmessage({ data: 'not JSON' });
    assert.equal(f.events.length, 1);
    f.session.mute(true);
    assert.equal(f.track.enabled, false);
    f.session.mute(false);
    assert.equal(f.track.enabled, true);
  } finally { f.session.disconnect(); }
  assert.equal(f.track.stopped, true);
  assert.equal(f.pc.closed, true);
  assert.equal(f.channel.closed, true);
  assert.equal(f.audio.srcObject, null);
});

test('cancellation while permission is pending stops late microphone tracks', async () => {
  let grant;
  const f = fixture({ getUserMedia: () => new Promise(resolve => { grant = resolve; }) });
  const connecting = f.session.connect(options);
  f.session.disconnect();
  grant(f.stream);
  await connecting;
  assert.equal(f.track.stopped, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.session.current, null);
});

test('setup and upstream failures release microphone and peer', async () => {
  for (const overrides of [
    { fetchImpl: async () => Response.json({ error: 'Project quota exceeded.' }, { status: 502 }) },
    { fetchImpl: async () => { throw new TypeError('Network failed'); } },
    { peerFactory: () => { throw new Error('Peer failed'); } },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(f.session.connect(options));
    assert.equal(f.track.stopped, true);
    assert.equal(f.session.current, null);
  }
});

test('cancelled SDP fetch cannot attach a stale answer', async () => {
  let answer;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const f = fixture({ fetchImpl: () => { requested(); return new Promise(resolve => { answer = resolve; }); } });
  const connecting = f.session.connect(options);
  await started;
  f.session.disconnect();
  answer(Response.json({ sdp: 'v=0 stale' }));
  await connecting;
  assert.equal(f.pc.remote, undefined);
  assert.equal(f.track.stopped, true);
});

test('failed peer and closed data channel release resources', async () => {
  for (const failure of ['peer', 'channel']) {
    const f = fixture();
    await f.session.connect(options);
    if (failure === 'peer') { f.pc.connectionState = 'failed'; f.pc.onconnectionstatechange(); }
    else f.channel.onclose();
    assert.equal(f.track.stopped, true);
    assert.equal(f.session.current, null);
  }
});

test('blocked autoplay exposes playback recovery', async () => {
  let blocked = false;
  const f = fixture({ audio: { srcObject: null, pause() {}, play: async () => { throw new Error('blocked'); } }, onPlaybackBlocked: () => { blocked = true; } });
  try {
    await f.session.connect(options);
    f.pc.ontrack({ streams: [f.stream] });
    await Promise.resolve();
    assert.equal(blocked, true);
  } finally { f.session.disconnect(); }
});
