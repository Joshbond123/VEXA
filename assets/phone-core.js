/**
 * VEXA phone core — the live Android viewer client.
 *
 * Talks to the VEXA phone backend over two WebSockets:
 *   /ws/viewer  → H.264 video packets (WebCodecs) + JSON state
 *   /ws/control → pointer / key / text input (JSON)
 *
 * Design rules (these exist because of the old "stuck phone shows a mock image" bug):
 *   • NOTHING is ever drawn that did not arrive from the device in this session.
 *   • No cached frame, no placeholder picture, no sessionStorage replay.
 *   • Any gap in the stream flips the UI to an explicit connection state and the
 *     client keeps reconnecting with backoff until the real picture returns.
 */
export const DEFAULT_BACKEND = 'wss://android.aivideo.prod.page';

export function backendUrl() {
  const saved = localStorage.getItem('vexa.backend');
  return (saved && saved.trim()) || DEFAULT_BACKEND;
}

export const STATES = {
  connecting: { label: 'Connecting to phone…', tone: 'warn' },
  live: { label: 'Live', tone: 'ok' },
  stalled: { label: 'Video stalled — recovering…', tone: 'warn' },
  reconnecting: { label: 'Reconnecting…', tone: 'warn' },
  offline: { label: 'Phone offline — retrying…', tone: 'bad' },
  unsupported: { label: 'This browser cannot decode H.264 (needs WebCodecs)', tone: 'bad' },
};

export class PhoneLink extends EventTarget {
  constructor({ canvas } = {}) {
    super();
    this.canvas = canvas || null;
    this.ctx = canvas ? canvas.getContext('2d', { alpha: false, desynchronized: true }) : null;
    this.viewer = null;
    this.control = null;
    this.decoder = null;
    this.config = null;
    this.codec = null;
    this.needKey = true;
    this.seq = 0;
    this.viewerRetry = 0;
    this.controlRetry = 0;
    this.reconnectTimer = 0;
    this.controlTimer = 0;
    this.state = 'connecting';
    this.sessionId = null;
    this.frames = 0;
    this.lastFrameAt = 0;
    // Liveness evidence. The backend replays its last keyframe to every new viewer,
    // so "I received a picture" is NOT proof of a live device. Only an advancing
    // encoder timestamp (PTS) is. This is what kills the old "stuck phone shows a
    // frozen image" bug.
    this.lastPts = 0;
    this.freshAt = 0;
    this.lastInputAt = 0;
    this.changeAt = 0;
    this.lastHash = 0;
    this.unresponsive = false;
    this.bytes = 0;
    this.bytesAt = performance.now();
    this.fps = 0;
    this.closedByUser = false;
    this._watchdog = 0;
  }

  /* ---------------------------------------------------------------- connect */
  connect() {
    this.closedByUser = false;
    this._setState('connecting');
    this._openViewer();
    this._openControl();
    clearInterval(this._watchdog);
    this._watchdog = setInterval(() => this._tick(), 1000);
  }

  close() {
    this.closedByUser = true;
    clearInterval(this._watchdog);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.controlTimer);
    try { this.viewer?.close(); } catch {}
    try { this.control?.close(); } catch {}
  }

  _openViewer() {
    clearTimeout(this.reconnectTimer);
    if (this.viewer && this.viewer.readyState < 2) return;
    let ws;
    try {
      ws = new WebSocket(`${backendUrl()}/ws/viewer?wake=1`);
    } catch {
      this._setState('offline');
      this._retryViewer();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.viewer = ws;

    // A handshake that hangs must not sit in CONNECTING forever.
    const openTimeout = setTimeout(() => { try { if (ws.readyState === 0) ws.close(); } catch {} }, 12000);

    ws.onopen = () => { clearTimeout(openTimeout); this.viewerRetry = 0; this._setState('connecting'); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { this._onFrame(e.data); return; }
      try { this._onMeta(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => { clearTimeout(openTimeout); this._retryViewer(); };
    ws.onerror = () => {};
  }

  _retryViewer() {
    if (this.closedByUser) return;
    this._setState(this.sessionId ? 'reconnecting' : 'offline');
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(10000, 500 * 2 ** this.viewerRetry++) + Math.random() * 250;
    this.reconnectTimer = setTimeout(() => this._openViewer(), delay);
  }

  _openControl() {
    clearTimeout(this.controlTimer);
    if (this.control && this.control.readyState < 2) return;
    let ws;
    try { ws = new WebSocket(`${backendUrl()}/ws/control`); } catch { this._retryControl(); return; }
    this.control = ws;
    ws.onopen = () => { this.controlRetry = 0; this.sendQos(); };
    ws.onmessage = () => {};
    ws.onclose = () => this._retryControl();
    ws.onerror = () => {};
  }

  _retryControl() {
    if (this.closedByUser) return;
    clearTimeout(this.controlTimer);
    const delay = Math.min(8000, 400 * 2 ** this.controlRetry++) + Math.random() * 200;
    this.controlTimer = setTimeout(() => this._openControl(), delay);
  }

  /* ------------------------------------------------------------------ video */
  _onFrame(buffer) {
    const data = new Uint8Array(buffer);
    if (data[0] === 0xff || data[0] === 0x01) { this._paintJpeg(data[0] === 0x01 ? data.subarray(1) : data); return; }
    if (data[0] !== 2) return;
    if (!('VideoDecoder' in window)) { this._setState('unsupported'); return; }

    const view = new DataView(buffer);
    const flags = view.getBigUint64(1, false);
    const isConfig = Boolean(flags & (1n << 63n));
    const isKey = Boolean(flags & (1n << 62n));
    const payload = data.subarray(13);

    const pts = Number(flags & ((1n << 62n) - 1n));
    if (!isConfig && pts > this.lastPts + 1000) {
      this.lastPts = pts;
      this.freshAt = performance.now();
      if (this.unresponsive && this.state === 'live') this.unresponsive = false;
    }

    if (isConfig) {
      this.config = payload.slice();
      this.codec = codecString(this.config);
      this._configureDecoder();
      return;
    }
    if (!this.decoder || !this.config) return;
    if (this.decoder.state !== 'configured') this._configureDecoder();
    if (this.needKey && !isKey) return;
    if (this.decoder.decodeQueueSize > 4) {
      this._configureDecoder();
      if (!isKey) return;
    }

    let chunk = payload;
    if (isKey) {
      this.needKey = false;
      chunk = new Uint8Array(this.config.length + payload.length);
      chunk.set(this.config, 0);
      chunk.set(payload, this.config.length);
    }
    const timestamp = Number(flags & ((1n << 62n) - 1n));
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data: chunk }));
    } catch {
      this.needKey = true;
    }
  }

  _configureDecoder() {
    if (!this.codec) return;
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch {} }
    this.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (this.canvas) {
            if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
              this.canvas.width = frame.displayWidth;
              this.canvas.height = frame.displayHeight;
            }
            this.ctx.drawImage(frame, 0, 0);
          }
          this.frames++;
          this.lastFrameAt = performance.now();
          this._hashFrame();
          if (performance.now() - this.freshAt < 2500) this._setState('live');
          this.dispatchEvent(new CustomEvent('frame'));
        } finally { frame.close(); }
      },
      error: () => { this.needKey = true; },
    });
    this.decoder.configure({ codec: this.codec, optimizeForLatency: true });
    this.needKey = true;
  }

  /** The backend may also send a still JPEG. It is a real device frame, never a mock. */
  async _paintJpeg(bytes) {
    if (!this.ctx) return;
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
        this.canvas.width = bmp.width; this.canvas.height = bmp.height;
      }
      this.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      this.frames++;
      this.lastFrameAt = performance.now();
      this.freshAt = performance.now();
      this._hashFrame();
      this._setState('live');
      this.dispatchEvent(new CustomEvent('frame'));
    } catch {}
  }

  /* ------------------------------------------------------------------- meta */
  _onMeta(msg) {
    if (msg.type === 'welcome') {
      this.sessionId = msg.active_session_id || null;
      this.deviceInfo = msg.device_info || null;
      if (!this.sessionId) this._setState('offline');
      this.dispatchEvent(new CustomEvent('session', { detail: { sessionId: this.sessionId, device: this.deviceInfo } }));
      return;
    }
    if (msg.type === 'no_phone') { this.sessionId = null; this._setState('offline'); this.dispatchEvent(new CustomEvent('session', { detail: { sessionId: null } })); return; }
    if (msg.type === 'phone_back') { this._setState('connecting'); return; }
    if (msg.type === 'stream_profile' || msg.profile) {
      this.dispatchEvent(new CustomEvent('profile', { detail: msg.profile || msg }));
    }
  }

  /* ------------------------------------------------------------------ input */
  sendInput(event) {
    this.lastInputAt = performance.now();
    if (this.control && this.control.readyState === 1) {
      const id = ++this.seq;
      this.control.send(JSON.stringify({ type: 'input', id, event }));
      return true;
    }
    // No control channel: still try to reconnect, but never pretend the tap landed.
    this._openControl();
    return false;
  }

  sendQos(level = this.level ?? 1) {
    if (this.control && this.control.readyState === 1) {
      this.control.send(JSON.stringify({ type: 'qos', level, visible: !document.hidden }));
    }
  }

  /* ------------------------------------------------------------------ state */
  _tick() {
    const now = performance.now();
    const age = now - (this.lastFrameAt || 0);
    this.fps = Math.round(this.frames * 1000 / Math.max(1, now - (this.startedAt ||= now)));
    this.startedAt ||= now;
    const fresh = now - (this.freshAt || 0);

    // No advancing encoder timestamp for 5 s ⇒ the device is not producing new
    // frames, whatever picture is on screen. Say so instead of faking "Live".
    if (this.state === 'live' && fresh > 5000) this._setState('stalled');

    // An input the device never reacted to within 4 s means the UI is wedged.
    const waiting = this.lastInputAt && this.lastInputAt > (this.changeAt || 0);
    const quiet = now - Math.max(this.changeAt || 0, this.lastInputAt || 0);
    if (waiting && now - this.lastInputAt > 4000 && quiet > 3000) {
      if (!this.unresponsive) {
        this.unresponsive = true;
        this.dispatchEvent(new CustomEvent('unresponsive'));
      }
    } else if (this.changeAt > (this.lastInputAt || 0)) {
      this.unresponsive = false;
    }
    if ((this.state === 'stalled' || this.state === 'reconnecting') && age > 12000 && this.viewer?.readyState === 1) {
      // Ask for a fresh keyframe by reopening the media socket; the backend replays
      // from its newest keyframe, so this is cheap.
      try { this.viewer.close(); } catch {}
    }
    this.dispatchEvent(new CustomEvent('tick', { detail: { fps: this.fps, state: this.state, age } }));
  }

  /** Cheap 8x8 luminance fingerprint: proves whether the picture actually changes. */
  _hashFrame() {
    if (!this.ctx || !this.canvas) return;
    try {
      const w = this.canvas.width, h = this.canvas.height;
      if (!w || !h) return;
      const data = this.ctx.getImageData(0, 0, w, h).data;
      let h1 = 0;
      const stepX = Math.max(1, Math.floor(w / 8)), stepY = Math.max(1, Math.floor(h / 8));
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const i = (((y * stepY) * w) + (x * stepX)) * 4;
          h1 = (h1 * 31 + (data[i] + data[i + 1] + data[i + 2])) | 0;
        }
      }
      if (h1 !== this.lastHash) { this.lastHash = h1; this.changeAt = performance.now(); }
    } catch {}
  }

  /** True when the device is producing frames and reacting to input. */
  isResponsive() {
    return this.state === 'live' && !this.unresponsive;
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: state }));
  }
}

/** Pull the avc1 profile string out of an Annex-B SPS/PPS blob. */
function codecString(bytes) {
  for (let i = 0; i < bytes.length - 6; i++) {
    let n = 0;
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) n = i + 3;
    else if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) n = i + 4;
    if (n && (bytes[n] & 31) === 7) {
      return 'avc1.' + [bytes[n + 1], bytes[n + 2], bytes[n + 3]].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  }
  return null;
}
