# WebRTC voice-chat prototype

A minimal local browser application for exploring voice conversation and comparing OpenAI Realtime API voices. It extends the supplied `RTCPeerConnection`, `getUserMedia` and `ontrack` example with an authenticated SDP exchange, session configuration, playback controls and resource cleanup. There are no third-party runtime dependencies or build steps.

## What this provides

The browser captures microphone audio and receives the model's speech over WebRTC. OpenAI detects speech turns and generates responses automatically, including interruption when you speak over a response. Choose an API voice and speaking instructions before connecting. The page supports microphone mute, disconnect/reconnect, assistant transcript display, and a playback button when browser autoplay is blocked. Transcripts are limited to 30 paragraphs and kept only in page memory.

This is a standalone API prototype, not an installed ChatGPT plugin. It does not connect to a ChatGPT account, custom GPT, existing chat, or native iOS voice session. You can copy your own custom GPT's instructions into the instructions field, but its tools, knowledge files, memory and conversation history are not imported.

## Run locally

Install Node.js **22.9 or later** (Node 24 LTS is suitable). No `npm install` is required.

```sh
git clone https://github.com/bwphwg5fwt-lang/codexshimmercodexshudder.git
cd codexshimmercodexshudder
# Until the prototype pull request is merged:
git switch prototype/webrtc-voice
cp .env.example .env
```

Edit `.env` locally and set `OPENAI_API_KEY` to an OpenAI API project key authorised for the configured Realtime model. Do not paste it into the browser, this README, a chat, or a commit. The default model is `gpt-realtime-2.1`, following the official WebRTC example reviewed on 31 October 2026. Use `OPENAI_REALTIME_MODEL` to select a different supported Realtime model if your project requires it. Model access and API billing or credits must be available to that API project; a ChatGPT login alone does not authenticate these API requests.

```sh
npm start
```

Open **http://localhost:3000** on the same computer as the server. The `localhost` hostname is required by the server's Host and Origin checks. Select a voice, adjust the instructions if needed, press Connect, and allow microphone access. Speak, then pause for a response. Headphones reduce acoustic feedback. If no audio plays, use the audio controls or Play received audio. Disconnect when finished to stop the microphone and close the peer connection. Ctrl+C stops the server. If port 3000 is occupied, change `PORT` in `.env` and use the printed URL.

A phone opening `localhost` refers to the phone, not your computer. This prototype deliberately binds only to `127.0.0.1`; remote devices and public hosting require a separate HTTPS deployment with application authentication. Opening `index.html` as a file will not work.

## Connection and authentication

1. The browser obtains the public model and voice configuration and a per-server anti-CSRF nonce from `/api/config`.
2. On Connect it creates a peer, adds the microphone track, creates the `oai-events` data channel and generates an SDP offer.
3. It posts the offer, selected voice and instructions to the same-origin `/api/session` route with the nonce. The server validates the origin, host, body and nonce, and applies connection-attempt limits.
4. The server posts multipart `sdp` and `session` fields to `https://api.openai.com/v1/realtime/calls`, using the API key exclusively in its server-side Authorization header.
5. It returns only the SDP answer. The browser calls `setRemoteDescription`. Microphone and generated audio flow between the browser and OpenAI; the data channel carries session and transcript events.

This uses the documented unified WebRTC interface, so the browser never needs a standard or ephemeral API key. The nonce is not an OpenAI credential or a user login. Access is limited to a local single-user process. Host/origin checks and the nonce protect against unsolicited browser requests; they do not protect against another user or malicious program already running on the same computer.

Only four static browser assets are served. `.env`, source files and arbitrary paths are not exposed. Responses are uncached, upstream error bodies are sanitised, and the server does not log keys, SDP, audio or transcripts. `.env` is ignored by Git. Session starts are limited to ten per minute and two simultaneous upstream handshakes; these are abuse controls, not spending limits. A connected session can continue generating billable usage. Use API project usage controls and disconnect when finished. The key authenticates session creation; the browser remains able to send commands over its own Realtime data channel, so this is not a server-enforced policy boundary.

## Exploring the voice-preservation goal

`shimmer` is the initial comparison voice, without asserting that it is the voice used in your iOS session. The selector also offers the other built-in voices listed in the official Realtime conversation guide. Disconnect before changing a voice: an API voice cannot be changed after audio has been generated in that session.

For a repeatable comparison, keep the same instructions, microphone, headphones and volume. Ask each voice to say a short fixed passage, for example: `Please say: I will explain this carefully. We can take one step at a time.` Compare accent, timbre, pace, prosody and perceived similarity. Note the model, voice name, instructions and date in your own comparison notes. Instructions can influence delivery, but they do not identify or preserve the underlying native ChatGPT voice implementation.

The official API documentation establishes a way to select API voices; it does not establish that an external application can reproduce the exact Standard Voice experience heard inside ChatGPT on iOS, including custom GPTs. This repository does not retrieve native ChatGPT voice assets, access private app endpoints, clone a voice, or preserve an older model. A familiar voice name or similar sound is not evidence of the same synthesis pipeline. API models, voice availability and behaviour can change, so retaining this code does not guarantee future retention of a particular sound. Exact native voice equivalence remains unverified.

The application does not record audio or persist transcripts. Audio is transmitted to OpenAI during an active, unmuted session; the provider's applicable data controls and retention policies still apply. Muting stops the outgoing microphone track but does not cancel an assistant response already being generated. Clearing the visible transcript does not erase the active model conversation. Reconnecting starts a new session.

## Verification

```sh
npm run check
npm test
```

Tests use Node's built-in test runner and a mocked OpenAI endpoint. They exercise the actual local HTTP routes, server-only authentication, both raw and JSON-wrapped SDP answers, validation, origin/host/nonce rejection, rate limits, sanitised failures, and browser-controller connection, mute, autoplay recovery and cleanup. They also cover disconnecting while microphone permission or the SDP exchange is pending. Tests do not contact OpenAI or require an API key.

The GitHub Actions workflow in `.github/workflows/validate.yml` runs these same commands on Node 22 and 24 for pull requests when opened, updated with new commits, reopened, edited or marked ready for review, and on pushes to `main`. Each matrix job has a five-minute timeout; a newer update cancels an older run. There are no dependencies to install. The workflow uses commit-pinned actions, read-only repository permissions and checkout without persisted credentials. It does not use repository secrets, set `OPENAI_API_KEY`, load `.env`, or run a live OpenAI session. No API key should be added to GitHub for these checks.

Automated validation: syntax checks and all 14 tests passed locally under Node 24.22.1. GitHub-hosted results are recorded separately in the pull request's Checks tab; a local pass alone does not establish a CI pass. A paid live OpenAI audio session and a physical microphone/browser compatibility test were not performed in the build environment. Offline tests cannot verify model access, actual ICE/media transport, audio quality, Safari behaviour or iOS voice equivalence.

Before merging, complete and record these manual checks separately from CI:

- A live OpenAI session with a valid server-side key: confirm model access, SDP/ICE negotiation, generated audio and transcript delivery.
- A physical microphone and speaker/headphone test: confirm input, output, interruption, mute, permission denial and microphone release on disconnect.
- An iPhone Safari compatibility test using an appropriately authenticated HTTPS deployment (the loopback-only server cannot be opened from a separate phone): confirm permissions, autoplay recovery, WebRTC media and reconnect behaviour. Record the iOS/browser version and results.

These checks remain uncompleted. Green CI does not establish audio quality, device compatibility, or equivalence to ChatGPT's native iOS voice functionality.

For the live smoke test, connect with a valid API key, speak and hear a reply, confirm the assistant transcript appears, mute and confirm speech is no longer received, then disconnect and confirm the browser microphone indicator clears. Reconnect with a different voice. Deny microphone access once and confirm the page gives recovery instructions. Use browser developer tools to confirm `/api/session` sends no API key. Do not share captured SDP or network exports publicly.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| API key missing | Set `.env`, restart the server and reload the page. |
| Authentication, model permission or quota error | Check the API project key, supported model access and API usage/billing. The ChatGPT subscription and GitHub repository role do not grant API model access. |
| Microphone denied or unavailable | Allow microphone permission for localhost, check the input device, and reconnect. |
| Connected but silent | Check system output and browser volume; press Play received audio; speak and pause. Try headphones. |
| Connection timeout | Confirm the server can reach `api.openai.com` over HTTPS and the browser network permits WebRTC media. Corporate networks, VPNs or firewalls may block media. No custom TURN relay is included. |
| Origin/host rejection | Use the exact localhost URL printed by the server; do not use a LAN IP, custom hostname or reverse proxy. |
| Too many attempts | Wait one minute, then retry. |

## Files and further work

`server.mjs` contains the local HTTP server and upstream handshake. `public/voice-session.js` owns microphone and WebRTC lifecycle. `public/app.js` supplies the controls and transcript display. The server's `createApp` and browser controller accept injected dependencies for offline tests.

A public or multi-user version needs HTTPS, authenticated users, per-user quotas, server-side policy controls and a deliberate data-retention design. A future ChatGPT integration would need its own supported integration mechanism; wrapping this page in a plugin would not itself make native iOS voice assets available.

Official references reviewed on 31 October 2026: [WebRTC connection guide](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime), [Realtime conversations and voices](https://developers.openai.com/api/docs/guides/realtime-conversations), and [Create Realtime call API reference](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create). The guide contains examples for multiple voice APIs; this implementation specifically uses the Realtime API `type: realtime` schema and `/v1/realtime/calls` endpoint.
