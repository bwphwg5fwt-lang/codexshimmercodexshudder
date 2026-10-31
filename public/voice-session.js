// Based on the supplied RTCPeerConnection/getUserMedia/ontrack audio example.
// Dependencies are injectable so connection races and cleanup can be tested offline.
export class VoiceSession {
  constructor({ audio, onStatus = () => {}, onEvent = () => {}, onPlaybackBlocked = () => {},
    peerFactory = () => new RTCPeerConnection(),
    getUserMedia = (options) => navigator.mediaDevices.getUserMedia(options), fetchImpl = fetch }) {
    Object.assign(this, { audio, onStatus, onEvent, onPlaybackBlocked, peerFactory, getUserMedia, fetchImpl });
    this.current = null;
  }

  async connect({ voice, instructions, nonce }) {
    this.disconnect();
    const run = { controller: new AbortController() };
    this.current = run;
    this.onStatus('Requesting microphone access…');
    try {
      const stream = await this.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.current !== run) { stream.getTracks().forEach(t => t.stop()); return; }
      run.stream = stream;
      const pc = run.pc = this.peerFactory();
      // Cover permission approval after a cancelled attempt and all setup failures.
      const timeout = () => {
        if (this.current === run) this.disconnect('Connection timed out. Check the network and reconnect.');
      };
      run.timer = setTimeout(timeout, 40000);
      pc.ontrack = (event) => {
        if (this.current !== run) return;
        this.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void this.audio.play().catch(() => this.onPlaybackBlocked());
      };
      pc.onconnectionstatechange = () => {
        if (this.current !== run) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(run.timer);
          this.onStatus('Connected. Speak to begin.');
        } else if (['failed', 'closed'].includes(pc.connectionState)) {
          this.disconnect('Connection closed. Reconnect to continue.');
        } else if (pc.connectionState === 'disconnected') {
          this.onStatus('Connection interrupted. Waiting for recovery…');
          clearTimeout(run.timer);
          run.timer = setTimeout(timeout, 15000);
        }
      };
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      const channel = run.channel = pc.createDataChannel('oai-events');
      channel.onmessage = ({ data }) => {
        if (this.current !== run) return;
        try { this.onEvent(JSON.parse(data)); } catch { /* Ignore non-JSON events. */ }
      };
      channel.onclose = () => {
        if (this.current === run) this.disconnect('Session ended. Reconnect to continue.');
      };
      channel.onerror = () => {
        if (this.current === run) this.disconnect('Session data channel failed. Reconnect to continue.');
      };
      this.onStatus('Connecting…');
      await pc.setLocalDescription(await pc.createOffer());
      if (this.current !== run) return;
      const response = await this.fetchImpl('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Nonce': nonce },
        body: JSON.stringify({ sdp: pc.localDescription.sdp, voice, instructions }),
        signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(30000)]),
      });
      const body = await response.json();
      if (this.current !== run) return;
      if (!response.ok) throw new Error(body.error || 'Connection failed.');
      await pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
    } catch (error) {
      if (this.current !== run) return;
      this.disconnect();
      throw error;
    }
  }

  mute(value) {
    this.current?.stream?.getAudioTracks().forEach(track => { track.enabled = !value; });
  }

  disconnect(message = 'Disconnected.') {
    const run = this.current;
    this.current = null;
    if (run) {
      clearTimeout(run.timer);
      run.controller.abort();
      run.stream?.getTracks().forEach(track => track.stop());
      if (run.channel) {
        run.channel.onclose = run.channel.onerror = run.channel.onmessage = null;
        run.channel.close();
      }
      if (run.pc) {
        run.pc.ontrack = run.pc.onconnectionstatechange = null;
        run.pc.close();
      }
    }
    this.audio.pause();
    this.audio.srcObject = null;
    this.onStatus(message);
  }
}
