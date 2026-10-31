import { VoiceSession } from './voice-session.js';
const $ = id => document.getElementById(id);
let config;
let muted = false;
let activeParagraph;
let activeItem;

function controls(active) {
  $('connect').disabled = active || !config?.configured;
  $('disconnect').disabled = !active;
  $('mute').disabled = !active || !session.current?.stream;
  $('voice').disabled = active || !config;
  $('instructions').disabled = active;
}
const session = new VoiceSession({
  audio: $('audio'),
  onStatus(message) {
    $('status').textContent = message;
    controls(Boolean(session.current));
    if (!session.current) {
      muted = false;
      $('mute').textContent = 'Mute microphone';
      $('mute').setAttribute('aria-pressed', 'false');
      $('play').hidden = true;
    }
  },
  onPlaybackBlocked() { $('play').hidden = false; },
  onEvent(event) {
    if (event.type === 'error') {
      // Do not display raw server events or provider diagnostics.
      $('status').textContent = 'The API reported a session error. Disconnect and reconnect; check model access if it persists.';
    }
    if (event.type === 'response.done' && event.response?.status === 'failed') {
      $('status').textContent = 'The API could not produce a response. Check API project usage and reconnect.';
    }
    if (event.type === 'response.output_audio_transcript.delta') {
      if (!activeParagraph || activeItem !== event.item_id) {
        activeParagraph = document.createElement('p');
        activeItem = event.item_id;
        $('transcript').append(activeParagraph);
        while ($('transcript').children.length > 30) $('transcript').firstChild.remove();
      }
      activeParagraph.textContent = (activeParagraph.textContent + (event.delta || '')).slice(-12000);
    }
    if (event.type === 'response.output_audio_transcript.done') activeParagraph = null;
  },
});

$('connect').onclick = async () => {
  activeParagraph = null;
  controls(true);
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw new Error('Use a browser supporting WebRTC at http://localhost on this computer.');
    }
    await session.connect({ voice: $('voice').value, instructions: $('instructions').value, nonce: config.nonce });
  } catch (error) {
    const messages = {
      NotAllowedError: 'Microphone access was denied. Allow microphone access in browser settings and reconnect.',
      NotFoundError: 'No microphone was found. Connect a microphone and retry.',
      NotReadableError: 'The microphone is unavailable. Check whether another application is using it.',
      TimeoutError: 'The connection timed out. Check the network and retry.',
    };
    $('status').textContent = messages[error.name] || error.message;
    controls(false);
  }
};
$('disconnect').onclick = () => session.disconnect();
$('mute').onclick = () => {
  muted = !muted;
  session.mute(muted);
  $('mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone';
  $('mute').setAttribute('aria-pressed', String(muted));
};
$('play').onclick = async () => {
  try { await $('audio').play(); $('play').hidden = true; }
  catch { $('status').textContent = 'Audio playback is blocked. Check browser audio permissions.'; }
};
$('clear').onclick = () => { $('transcript').replaceChildren(); activeParagraph = null; };
window.addEventListener('pagehide', () => session.disconnect());
try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error();
  config = await response.json();
  for (const voice of config.voices) $('voice').add(new Option(voice, voice));
  $('voice').value = config.defaultVoice;
  $('model').textContent = `API model: ${config.model}`;
  controls(false);
  $('status').textContent = config.configured ? 'Ready. Connect to enable your microphone.' : 'Set OPENAI_API_KEY in .env and restart the server, then reload this page.';
} catch { $('status').textContent = 'Unable to load configuration. Open the localhost URL printed by the server.'; }
