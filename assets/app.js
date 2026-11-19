/*
 * VEXA — Autonomous AI Android Agent
 * Frontend logic. GitHub Pages frontend + Cloudflare Workers backend.
 *
 * The backend holds every secret; this file contains no keys.
 */
(() => {
  'use strict';

  const API = 'https://vexa-ai-agent.replyraven001.workers.dev';
  // Adaptive streaming: the poll interval and frame quality scale with measured
  // link speed. A fast link gets smooth 700ms updates at full resolution; a weak
  // link drops to a downscaled JPEG every few seconds instead of timing out.
  const SCREEN_POLL_MS = 1600;      // starting interval before adaptation kicks in
  const POLL_FAST_MS = 700;         // best case, healthy link
  const POLL_SLOW_MS = 4000;        // worst case, weak link
  const STATUS_POLL_MS = 15000;

  const PROVIDERS = {
    nvidia: { label: 'NVIDIA NIM', model: 'nemotron-3.5-super-vl-120b-a12b' },
    grok: { label: 'xAI Grok', model: 'grok-2-vision-1212' },
    openai: { label: 'OpenAI-compatible', model: 'gpt-4o-mini' },
  };

  const state = {
    automations: [],
    activeAutoId: '',
    activeAutomation: null,
    conversations: [],
    activeConversationId: '',
    editingConversationId: '',
    chat: [],
    device: { online: false, hasFrame: false, frameFresh: false, model: '', version: '', resolution: '' },
    streamTimer: null,
    statusTimer: null,
    screenSignature: null,
    streaming: false,
    chatBusy: false,
    frameInFlight: false,
    frameFailures: 0,
    // Adaptive link quality. `quality` is 0..1 (1 = best). `pollMs` is the live
    // interval; both are recomputed from observed frame latency and failures.
    quality: 1,
    pollMs: SCREEN_POLL_MS,
    lastFrameBytes: 0,
    consecutiveFailures: 0,
    maxQualityHeight: 1080,
    streamAbort: null,
    activitySource: null,
  };

  /* ------------------------------------------------------------------ dom */
  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls = 'ic') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
  const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /* ------------------------------------------------------------------ toast */
  function toast(msg, kind = 'info', ms = 4200) {
    const box = $('toastContainer');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : ''}`;
    el.innerHTML = `<div style="flex:1">${esc(msg)}</div><button class="toast-close" aria-label="Dismiss">${icon('i-close', 'ic ic-sm')}</button>`;
    box.appendChild(el);
    const kill = () => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 250); };
    el.querySelector('.toast-close').addEventListener('click', kill);
    setTimeout(kill, ms);
  }

  /* ------------------------------------------------------------------ api */
  async function api(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const detail = body && (body.error || body.message) ? `: ${body.error || body.message}` : '';
      throw new Error(`${res.status}${detail}`);
    }
    return body || {};
  }

  /* ================================================================ DEVICE */
  function setPill(el, cls, text) {
    if (!el) return;
    el.className = `pill ${cls}`;
    el.innerHTML = `<span class="pill-dot"></span><span>${esc(text)}</span>`;
  }

  function applyDeviceState(d) {
    state.device = {
      online: !!d.online,
      hasFrame: !!d.hasFrame,
      frameFresh: !!d.frameFresh,
      model: d.deviceModel || '',
      version: d.androidVersion || '',
      resolution: d.resolution || '',
    };

    const label = d.online ? 'Online' : 'Offline';
    const cls = d.online ? 'online' : 'offline';

    setPill($('headerStatusPill'), cls, label);
    setPill($('deviceStatusPill'), cls, label);
    setPill($('sidebarEmuStatus'), cls, label);
    setPill($('mobileEmuStatus'), cls, label);

    const desc = d.online
      ? [d.deviceModel, d.androidVersion ? `Android ${d.androidVersion}` : '', d.resolution].filter(Boolean).join(' · ')
      : (d.registered ? 'Registered, heartbeat stale' : 'Not connected');
    for (const id of ['sidebarEmuMeta', 'mobileEmuMeta']) {
      const el = $(id); if (el) el.textContent = desc;
    }

    const hg = $('headerGateway');
    if (hg) hg.textContent = d.online ? (d.deviceModel || 'Android device') : 'No device';

    const statDevice = $('statDevice');
    if (statDevice) statDevice.textContent = d.online ? 'Online' : 'Offline';
    const sd = $('settingsEmuStatus');
    if (sd) sd.textContent = d.online
      ? `Online — ${desc}`
      : 'Offline. Click Start emulator to launch one (boot takes 5–10 minutes).';

    const modelLabel = $('deviceModelLabel');
    if (modelLabel) modelLabel.textContent = d.deviceModel ? `${d.deviceModel}` : '—';
    const resLabel = $('deviceResLabel');
    if (resLabel) resLabel.textContent = d.resolution || '';
    const frameLabel = $('deviceFrameLabel');
    if (frameLabel) {
      if (!d.online) frameLabel.textContent = '';
      else if (d.frameFresh) frameLabel.textContent = 'live';
      else if (d.hasFrame) frameLabel.textContent = 'stale frame';
      else frameLabel.textContent = 'waiting for frame…';
    }

    // "Can the agent see and control the phone?" — reported from the real state:
    // a fresh frame plus a decoded UI tree, and an online session.
    const note = $('deviceCaptureNote');
    const noteText = $('deviceCaptureText');
    if (note && noteText) {
      note.classList.remove('ok', 'bad', 'warn');
      if (!d.online) {
        note.classList.add('bad');
        noteText.textContent = 'Agent cannot see the phone — emulator is offline.';
      } else if (d.hasUiTree && d.frameFresh) {
        note.classList.add('ok');
        noteText.textContent = 'Agent can see and control the phone (live frame + UI tree).';
      } else if (d.frameFresh) {
        note.classList.add('warn');
        noteText.textContent = 'Agent sees live frames; waiting for the UI element tree.';
      } else if (d.hasFrame) {
        note.classList.add('warn');
        noteText.textContent = 'Frame present but stale — agent vision is paused until it refreshes.';
      } else {
        note.classList.add('warn');
        noteText.textContent = 'Online but no frame yet — first screenshot is still arriving.';
      }
    }
    applyLinkBadge();

    // Overlay: hide only when a usable frame is on screen.
    const overlay = $('phoneOfflineOverlay');
    if (overlay) overlay.classList.toggle('hidden', d.online && d.frameFresh);

    const chatSub = $('chatSub');
    if (chatSub) {
      chatSub.textContent = d.online
        ? `Connected · ${d.deviceModel || 'Android'}`
        : 'Device offline — start the emulator to control the phone';
    }
  }

  async function refreshStatus() {
    try {
      const d = await api('/api/frontend/emulator-status');
      applyDeviceState(d);
      if (d.online && d.frameFresh) startStream();
      return d;
    } catch (err) {
      applyDeviceState({ online: false, registered: false });
      return { online: false };
    }
  }

  /* ---------------------------------------------------------------- stream */
  /* Adaptive quality: measure each frame's transfer time and size, then move
   * the poll interval and the requested frame height in the direction the link
   * can actually sustain. Fast link → smaller interval, full resolution; weak
   * link → longer interval, downscaled frame. The previous fixed 1600ms poll at
   * full 1080x2400 made every frame a multi-second download on a slow phone
   * connection, so the preview appeared frozen and actions looked lost. */
  function adaptQuality(latencyMs, bytes) {
    const slow = latencyMs > 2500 || state.consecutiveFailures >= 2;
    const fast = latencyMs < 900 && state.consecutiveFailures === 0;
    if (slow) {
      state.quality = Math.max(0.2, state.quality - 0.2);
      state.pollMs = Math.min(POLL_SLOW_MS, Math.round(state.pollMs * 1.5));
    } else if (fast) {
      state.quality = Math.min(1, state.quality + 0.1);
      state.pollMs = Math.max(POLL_FAST_MS, Math.round(state.pollMs * 0.85));
    }
    // Requested height follows quality; never below a legible 320px.
    state.maxQualityHeight = Math.round(320 + state.quality * (1080 - 320));
    state.lastFrameBytes = bytes;
    applyLinkBadge();
  }

  function applyLinkBadge() {
    const el = $('deviceLinkLabel');
    if (!el) return;
    if (!state.device.online) { el.textContent = ''; return; }
    const kbps = state.lastFrameBytes && state.pollMs
      ? Math.round((state.lastFrameBytes * 8) / state.pollMs)
      : 0;
    const tier = state.quality > 0.75 ? 'HD' : state.quality > 0.45 ? 'SD' : 'low';
    el.textContent = kbps ? `live · ${tier} · ~${kbps} kbps` : 'live';
  }

  function startStream() {
    if (state.streaming) return;
    state.streaming = true;
    scheduleTick(0);
  }

  function stopStream() {
    state.streaming = false;
    if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }
  }

  // Self-scheduling loop instead of setInterval: the next frame is only requested
  // after the previous one finished, so ticks can never stack up on a slow link.
  function scheduleTick(delay) {
    if (!state.streaming) return;
    if (state.streamTimer) clearTimeout(state.streamTimer);
    state.streamTimer = setTimeout(async () => {
      await pullFrame();
      scheduleTick(state.pollMs);
    }, delay);
  }

  async function pullFrame() {
    const canvas = $('phoneCanvas');
    if (!canvas || state.frameInFlight) return;
    state.frameInFlight = true;
    const ctx = canvas.getContext('2d');
    const started = performance.now();
    // Abort a frame that outlives the poll interval: on a weak link a hung
    // request otherwise blocks the whole loop until the browser gives up.
    const ctrl = new AbortController();
    state.streamAbort = ctrl;
    const killer = setTimeout(() => ctrl.abort(), Math.max(4000, state.pollMs * 2));
    try {
      const url = `${API}/api/public/screenshot?h=${state.maxQualityHeight}&t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) { state.consecutiveFailures++; state.frameFailures++; return; }
      const blob = await res.blob();
      if (blob.size < 200) { state.consecutiveFailures++; state.frameFailures++; return; }
      const bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      state.consecutiveFailures = 0;
      state.frameFailures = 0;
      const overlay = $('phoneOfflineOverlay');
      if (overlay) overlay.classList.add('hidden');
      adaptQuality(performance.now() - started, blob.size);
    } catch {
      state.consecutiveFailures++;
      state.frameFailures++;
      // Keep the loop alive on a dropped connection; the next tick retries and
      // status polling will flip the UI to offline if the device is truly gone.
      if (state.consecutiveFailures >= 3) adaptQuality(99999, 0);
    } finally {
      clearTimeout(killer);
      state.streamAbort = null;
      state.frameInFlight = false;
    }
  }

  /* -------------------------------------------------------------- actions */
  // Actions are queued with a client id and de-duplicated: a double tap on a
  // slow link must not fire the same device command twice, and an in-flight
  // action blocks a second one until it resolves or times out.
  let actionSeq = 0;
  let actionInFlight = false;
  async function deviceAction(action, params = {}) {
    if (!state.device.online) { toast('Device is offline. Start the emulator first.', 'warn'); return false; }
    if (actionInFlight) return false; // drop the duplicate rather than queue a burst
    actionInFlight = true;
    const clientId = `act_${Date.now()}_${++actionSeq}`;
    try {
      await api('/api/emulator/action', { method: 'POST', body: JSON.stringify({ action, ...params, clientId }) });
      // Pull the post-action frame as soon as the emulator reports it executed.
      waitForActionResult(clientId);
      return true;
    } catch (err) {
      toast(`Action failed: ${err.message}`, 'err');
      return false;
    } finally {
      // Release quickly: adb input returns in well under a second, and holding
      // this longer than the round trip makes rapid taps feel unresponsive.
      setTimeout(() => { actionInFlight = false; }, 250);
    }
  }

  // Poll for the result of a specific queued action so the frame refreshes the
  // moment the device actually executed it (not on a blind fixed delay).
  async function waitForActionResult(clientId, attempt = 0) {
    if (attempt > 12) return;
    try {
      const d = await api('/api/emulator/action-status');
      if (d && d.clientId === clientId && d.state === 'done') {
        await pullFrame();
        return;
      }
    } catch { /* keep waiting */ }
    setTimeout(() => waitForActionResult(clientId, attempt + 1), 400);
  }

  function toDeviceCoords(ev, canvas) {
    const r = canvas.getBoundingClientRect();
    const x = Math.round(((ev.clientX - r.left) / r.width) * canvas.width);
    const y = Math.round(((ev.clientY - r.top) / r.height) * canvas.height);
    return { x: Math.max(0, Math.min(canvas.width, x)), y: Math.max(0, Math.min(canvas.height, y)) };
  }

  function setupPhoneInput() {
    const stage = $('phoneStage');
    const canvas = $('phoneCanvas');
    if (!stage || !canvas) return;

    const TAP_SLOP = 14;        // px of movement still counted as a tap
    const LONG_PRESS_MS = 500;  // hold with no movement → long press

    let gesture = null;

    const lockScroll = () => document.body.classList.add('device-gesture-active');
    const unlockScroll = () => document.body.classList.remove('device-gesture-active');

    function begin(e) {
      // Only the primary pointer drives the phone; extra fingers are ignored so a
      // second finger cannot hijack the gesture.
      if (gesture || (e.isPrimary === false)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Capture the pointer: all later move/up events go to this element even if
      // the finger leaves the phone, so a swipe off the edge still completes.
      try { stage.setPointerCapture(e.pointerId); } catch { /* not supported */ }
      const start = toDeviceCoords(e, canvas);
      gesture = {
        pointerId: e.pointerId,
        start,
        last: start,
        startAt: performance.now(),
        lastSampleAt: 0,
        moved: false,
        longPressTimer: setTimeout(() => {
          if (gesture && !gesture.moved) {
            // Long press: Android treats a stationary press of ~700ms as a hold.
            // adb has no native long-press, so a same-point swipe of that
            // duration is the documented equivalent.
            gesture.longPressFired = true;
            deviceAction('swipe', {
              x: gesture.start.x, y: gesture.start.y,
              x2: gesture.start.x, y2: gesture.start.y,
              duration_ms: 700,
            });
          }
        }, LONG_PRESS_MS),
      };
      lockScroll();
      e.preventDefault();
    }

    function move(e) {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      const p = toDeviceCoords(e, canvas);
      if (Math.abs(p.x - gesture.start.x) > TAP_SLOP || Math.abs(p.y - gesture.start.y) > TAP_SLOP) {
        gesture.moved = true;
        if (gesture.longPressTimer) { clearTimeout(gesture.longPressTimer); gesture.longPressTimer = null; }
      }
      gesture.last = p;
      e.preventDefault();
    }

    async function end(e) {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      const g = gesture;
      gesture = null;
      if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
      unlockScroll();
      try { stage.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (g.longPressFired) return; // long press already dispatched

      const up = toDeviceCoords(e, canvas);
      const dx = Math.abs(up.x - g.start.x);
      const dy = Math.abs(up.y - g.start.y);
      const elapsed = performance.now() - g.startAt;

      if (dx < TAP_SLOP && dy < TAP_SLOP) {
        await deviceAction('tap', { x: up.x, y: up.y });
      } else {
        // Report the real gesture duration so a slow drag is a drag and a flick
        // is a fling — a fixed 300ms made every swipe feel like a scroll.
        const duration = Math.max(80, Math.min(1200, Math.round(elapsed)));
        await deviceAction('swipe', { x: g.start.x, y: g.start.y, x2: up.x, y2: up.y, duration_ms: duration });
      }
    }

    function cancel(e) {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      if (gesture.longPressTimer) clearTimeout(gesture.longPressTimer);
      gesture = null;
      unlockScroll();
    }

    on(stage, 'pointerdown', begin);
    on(stage, 'pointermove', move);
    on(stage, 'pointerup', end);
    on(stage, 'pointercancel', cancel);
    // Belt-and-braces for browsers that fire touch events without pointer events:
    // stopping the default on touchmove is what actually prevents the page from
    // scrolling underneath the phone.
    on(stage, 'touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    on(stage, 'contextmenu', (e) => e.preventDefault());
    // Double-tap zoom on the phone viewport would zoom the whole page.
    on(stage, 'dblclick', (e) => e.preventDefault());
  }

  /* ================================================================= CHAT */
  /* ------------------------------------------------- conversations (history) */
  function humanAction(a) {
    if (!a || !a.action) return 'device action';
    switch (a.action) {
      case 'tap': return `Tapping the screen at ${a.x},${a.y}`;
      case 'swipe': return 'Swiping the screen';
      case 'scroll': return `Scrolling ${a.direction || 'down'}`;
      case 'type': return `Typing "${a.text || ''}"`;
      case 'launch': return `Opening ${a.app || a.text || 'an app'}`;
      case 'back': return 'Pressing Back';
      case 'home': return 'Going to the home screen';
      case 'key': return `Pressing key ${a.keycode}`;
      default: return `Running ${a.action}`;
    }
  }

  function relTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return '';
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  async function loadConversations() {
    try {
      const d = await api('/api/frontend/conversations');
      state.conversations = Array.isArray(d.conversations) ? d.conversations : [];
      renderConversations();
    } catch { /* sidebar is non-critical */ }
  }

  function renderConversations() {
    const list = $('chatHistoryList');
    if (!list) return;
    const q = ($('chatSearchInput')?.value || '').trim().toLowerCase();
    const items = state.conversations.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
    if (!items.length) {
      list.innerHTML = `<div class="chat-history-empty">${q ? 'No matching chats' : 'No chats yet'}</div>`;
      return;
    }
    list.innerHTML = '';
    for (const c of items) {
      const el = document.createElement('div');
      el.className = `chat-item${c.id === state.activeConversationId ? ' active' : ''}`;
      el.dataset.id = c.id;

      // Inline rename: the title becomes an input, edits save to the backend,
      // and the server never regenerates a title the user has set.
      if (state.editingConversationId === c.id) {
        el.innerHTML = `
          <div class="chat-item-body">
            <input class="chat-rename-input" type="text" maxlength="120" value="${esc(c.title || '')}" aria-label="Rename chat" />
            <div class="chat-rename-actions">
              <button class="btn btn-primary btn-sm" data-act="save-title">Save</button>
              <button class="btn btn-ghost btn-sm" data-act="cancel-title">Cancel</button>
            </div>
          </div>`;
        list.appendChild(el);
        const input = el.querySelector('.chat-rename-input');
        input.focus();
        input.select();
        const save = () => saveConversationTitle(c, input.value);
        const cancel = () => { state.editingConversationId = ''; renderConversations(); };
        el.querySelector('[data-act="save-title"]').addEventListener('click', save);
        el.querySelector('[data-act="cancel-title"]').addEventListener('click', cancel);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        continue;
      }

      el.innerHTML = `
        <div class="chat-item-body">
          <div class="chat-item-title">${esc(c.title || 'New chat')}</div>
          <div class="chat-item-meta">${esc(relTime(c.updatedAt))}${c.automationId ? ' · <span class="action-tag">task</span>' : ''}</div>
        </div>
        <button class="chat-item-rename" title="Rename chat">${icon('i-edit')}</button>
        <button class="chat-item-del" title="Delete chat">${icon('i-close')}</button>`;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.chat-item-del') || e.target.closest('.chat-item-rename')) return;
        openConversation(c.id);
      });
      el.querySelector('.chat-item-rename').addEventListener('click', (e) => {
        e.stopPropagation();
        state.editingConversationId = c.id;
        renderConversations();
      });
      el.querySelector('.chat-item-del').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(c);
      });
      list.appendChild(el);
    }
  }

  async function saveConversationTitle(conv, rawTitle) {
    const title = String(rawTitle || '').trim();
    if (!title) { toast('Title cannot be empty', 'warn'); return; }
    try {
      await api(`/api/frontend/conversations/${encodeURIComponent(conv.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
      const local = state.conversations.find((c) => c.id === conv.id);
      if (local) local.title = title;
      if (state.activeConversationId === conv.id) {
        const t = $('chatTitle');
        if (t) t.textContent = title;
      }
      state.editingConversationId = '';
      renderConversations();
      toast('Chat renamed', 'ok', 1800);
    } catch (err) {
      toast(`Rename failed: ${err.message}`, 'err');
    }
  }

  async function openConversation(id) {
    if (!id) return;
    state.activeConversationId = id;
    const conv = state.conversations.find((c) => c.id === id);
    const title = $('chatTitle');
    if (title) title.textContent = conv?.title || 'VEXA Agent';
    const box = $('chatMessages');
    if (box) box.innerHTML = '';
    state.chat = [];
    try {
      const d = await api(`/api/frontend/conversations/${encodeURIComponent(id)}/messages`);
      for (const m of (d.messages || [])) {
        if (m.role === 'system') continue;
        appendMessage(m.role, m.content, relTime(m.timestamp));
        state.chat.push({ role: m.role, content: m.content });
      }
      if (!state.chat.length) renderWelcome();
    } catch {
      renderWelcome();
    }
    renderConversations();
    $('chatHistory')?.classList.remove('open');
  }

  function newChat() {
    state.activeConversationId = '';
    state.chat = [];
    const title = $('chatTitle');
    if (title) title.textContent = 'VEXA Agent';
    const box = $('chatMessages');
    if (box) box.innerHTML = '';
    renderWelcome();
    renderConversations();
    $('chatSuggest')?.classList.remove('hidden');
    $('chatHistory')?.classList.remove('open');
  }

  async function deleteChat(conv) {
    if (!confirm(`Delete "${conv.title || 'this chat'}"? This cannot be undone.`)) return;
    try {
      await api(`/api/frontend/conversations/${encodeURIComponent(conv.id)}`, { method: 'DELETE' });
      if (state.activeConversationId === conv.id) newChat();
      await loadConversations();
      toast('Chat deleted', 'ok');
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'err');
    }
  }

  function renderWelcome() {
    const box = $('chatMessages');
    if (!box) return;
    box.innerHTML = `
      <div class="chat-welcome">
        <div class="w-ic">${icon('i-sparkle')}</div>
        <h3>How can I help?</h3>
        <p>Ask me about the phone, or give me a task. When the device is online I can see the screen and act on it.</p>
      </div>`;
  }

  function bubbleEl(role, text, meta) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const avatar = role === 'agent'
      ? `<div class="msg-avatar">${icon('i-sparkle', 'ic')}</div>`
      : role === 'user'
        ? `<div class="msg-avatar">${icon('i-phone', 'ic')}</div>`
        : '';
    const metaHtml = meta ? `<div class="msg-time">${esc(meta)}</div>` : '';
    wrap.innerHTML = `${avatar}<div><div class="bubble">${esc(text)}</div>${metaHtml}</div>`;
    return wrap;
  }

  function appendMessage(role, text, meta) {
    const box = $('chatMessages');
    if (!box) return null;
    const welcome = box.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
    const el = bubbleEl(role, text, meta || nowTime());
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function showTyping() {
    const box = $('chatMessages');
    if (!box) return null;
    const welcome = box.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.id = 'typingMsg';
    el.innerHTML = `<div class="msg-avatar">${icon('i-sparkle', 'ic')}</div><div><div class="bubble typing"><i></i><i></i><i></i></div></div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function clearTyping() {
    const t = $('typingMsg');
    if (t) t.remove();
  }

  function setChatBusy(busy) {
    state.chatBusy = busy;
    const btn = $('chatSendBtn');
    if (btn) {
      btn.disabled = busy;
      btn.innerHTML = busy ? '<span class="spinner"></span>' : icon('i-send');
    }
    const input = $('chatInput');
    if (input) input.disabled = busy;
  }

  async function sendChat(text) {
    const msg = String(text || '').trim();
    if (!msg || state.chatBusy) return;

    appendMessage('user', msg);
    state.chat.push({ role: 'user', content: msg });
    const input = $('chatInput');
    if (input) { input.value = ''; autoGrow(input); }
    const suggest = $('chatSuggest');
    if (suggest) suggest.classList.add('hidden');

    setChatBusy(true);
    showTyping();

    try {
      const data = await api('/api/frontend/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: msg,
          conversationId: state.activeConversationId || null,
          automationId: state.activeAutoId || null,
          history: state.chat.slice(-8),
        }),
      });
      clearTyping();

      if (!data.ok) {
        appendMessage('agent', `I couldn't reach the AI provider. ${data.error || ''}`.trim());
        toast(data.error || 'AI request failed', 'err');
      } else {
        appendMessage('agent', data.reply);
        state.chat.push({ role: 'agent', content: data.reply });
        if (data.conversationId && data.conversationId !== state.activeConversationId) {
          state.activeConversationId = data.conversationId;
          loadConversations();
        }
        if (data.createdAutomation) {
          // A real automation was created server-side; surface it and refresh the
          // dashboard so it appears immediately.
          appendMessage('system', `Automation created: ${data.createdAutomation.name} (${scheduleLabel(data.createdAutomation)})`);
          toast('Automation created', 'ok');
          await loadAutomations();
        }
        if (data.queuedAction) {
          appendMessage('system', humanAction(data.queuedAction));
          setTimeout(pullFrame, 1200);
        }
      }
    } catch (err) {
      clearTyping();
      appendMessage('agent', `Request failed: ${err.message}`);
      toast(`Chat failed: ${err.message}`, 'err');
    } finally {
      setChatBusy(false);
      const inp = $('chatInput');
      if (inp) inp.focus();
    }
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  /* ========================================================= AUTOMATIONS */
  async function loadAutomations() {
    try {
      const data = await api('/api/frontend/automations');
      state.automations = Array.isArray(data.automations) ? data.automations : [];
    } catch {
      state.automations = [];
    }
    renderAutomations();
    renderAutomationSelect();
    const badge = $('autoCountBadge');
    if (badge) badge.textContent = String(state.automations.length);
    const stat = $('statAutomations');
    if (stat) stat.textContent = String(state.automations.length);
    const runs = $('statRuns');
    if (runs) runs.textContent = String(state.automations.reduce((n, a) => n + (a.runCount || 0), 0));
  }

  function renderAutomations() {
    const list = $('automationsList');
    if (!list) return;
    if (!state.automations.length) {
      list.innerHTML = `<div class="empty-state">
        <div class="es-ic">${icon('i-bolt')}</div>
        <h3>No automations yet</h3>
        <p>Create one to have the agent run a task on the live Android device on a schedule.</p>
      </div>`;
      return;
    }
    list.innerHTML = state.automations.map((a) => {
      const status = a.paused ? 'stopped' : (a.status || 'idle');
      return `<div class="auto-card">
        <div class="auto-top">
          <h3>${esc(a.name)}</h3>
          <span class="pill ${statusClass(status)}">${esc(status.replace(/_/g, ' '))}</span>
        </div>
        <p>${esc(a.instructions || 'No instructions')}</p>
        <div class="auto-meta">
          ${esc(scheduleLabel(a))} · runs ${a.runCount || 0}${a.nextRunAt ? `<br>next ${esc(new Date(a.nextRunAt).toLocaleString())}` : ''}${a.lastRunAt ? `<br>last ${esc(new Date(a.lastRunAt).toLocaleString())}` : ''}
        </div>
        <div class="auto-actions">
          <button class="btn btn-secondary btn-sm" data-act="open" data-id="${a.id}">${icon('i-chat', 'ic ic-sm')}Open</button>
          <button class="btn btn-primary btn-sm" data-act="run" data-id="${a.id}">${icon('i-play', 'ic ic-sm')}Run</button>
          <button class="btn btn-ghost btn-sm" data-act="pause" data-id="${a.id}">${a.paused ? 'Resume' : 'Pause'}</button>
          <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${a.id}">${icon('i-edit', 'ic ic-sm')}</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-id="${a.id}">${icon('i-trash', 'ic ic-sm')}</button>
        </div>
      </div>`;
    }).join('');
  }

  /* ------------------------------------------- automation detail view */
  async function openAutomation(id) {
    state.activeAutoId = id;
    state.activeAutomation = state.automations.find((a) => a.id === id) || null;
    showView('automation');
    const nameEl = $('autoDetailName');
    const subEl = $('autoDetailSub');
    if (nameEl) nameEl.textContent = state.activeAutomation?.name || 'Automation';
    if (subEl) subEl.textContent = state.activeAutomation ? scheduleLabel(state.activeAutomation) : '';
    await loadAutomationDetail(id);
    subscribeAutomationEvents(id);
  }

  async function loadAutomationDetail(id) {
    const messagesEl = $('autoDetailMessages');
    const execEl = $('autoDetailExecutions');
    const activityEl = $('autoDetailActivity');
    if (messagesEl) messagesEl.innerHTML = `<div class="report-meta" style="padding:14px">Loading…</div>`;
    try {
      const d = await api(`/api/frontend/automations/${encodeURIComponent(id)}`);
      const a = d.automation || {};
      state.activeAutomation = a;
      const nameEl = $('autoDetailName');
      if (nameEl) nameEl.textContent = a.name || 'Automation';
      const subEl = $('autoDetailSub');
      if (subEl) {
        const bits = [scheduleLabel(a), a.nextRunAt ? `next run ${new Date(a.nextRunAt).toLocaleString()}` : 'no next run'];
        subEl.textContent = bits.join(' · ');
      }
      const status = a.paused ? 'stopped' : (a.status || 'idle');
      setPill($('autoDetailStatus'), statusClass(status), status.replace(/_/g, ' '));
      const pauseBtn = $('autoDetailPauseBtn');
      if (pauseBtn) pauseBtn.textContent = a.paused ? 'Resume' : 'Pause';

      // Conversation: the automation's own prompt + the agent's real responses.
      if (messagesEl) {
        messagesEl.innerHTML = '';
        const msgs = Array.isArray(d.messages) ? d.messages : [];
        if (!msgs.length) {
          messagesEl.innerHTML = `<div class="chat-welcome"><div class="w-ic">${icon('i-bolt')}</div>
            <h3>No conversation yet</h3>
            <p>This automation has not produced any messages. Run it to see the agent's real activity here.</p></div>`;
        } else {
          // Always show the original prompt first, then each real message.
          messagesEl.appendChild(bubbleEl('user', a.instructions || a.name, 'task prompt'));
          for (const m of msgs) {
            if (m.role === 'system') continue;
            messagesEl.appendChild(bubbleEl(m.role, m.content, m.timestamp ? new Date(m.timestamp).toLocaleString() : ''));
          }
        }
      }

      renderExecutions(execEl, d.executions || []);
      renderActivity(activityEl, d.events || []);
    } catch (err) {
      if (messagesEl) messagesEl.innerHTML = `<div class="empty-state"><div class="es-ic">${icon('i-alert')}</div><h3>Couldn't load automation</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function renderExecutions(el, executions) {
    if (!el) return;
    if (!executions.length) {
      el.innerHTML = `<div class="chat-history-empty">No executions recorded yet</div>`;
      return;
    }
    el.innerHTML = executions.map((e) => `
      <div class="exec-item">
        <div class="exec-top">
          <span class="pill ${statusClass(e.status)}">${esc(String(e.status || '').replace(/_/g, ' '))}</span>
          <span class="exec-time">${esc(e.startedAt ? new Date(e.startedAt).toLocaleString() : '')}</span>
        </div>
        <div class="exec-meta">${(e.actionsPerformed || []).length} action(s) · outcome ${e.outcomeAchieved ? 'achieved' : 'not achieved'}</div>
        ${e.observedResults ? `<p class="exec-observed">${esc(e.observedResults)}</p>` : ''}
        ${e.failures ? `<p class="exec-fail">${esc(e.failures)}</p>` : ''}
      </div>`).join('');
  }

  function renderActivity(el, events) {
    if (!el) return;
    if (!events.length) {
      el.innerHTML = `<div class="chat-history-empty">No activity yet</div>`;
      return;
    }
    el.innerHTML = events.map(activityRow).join('');
    el.scrollTop = el.scrollHeight;
  }

  function activityRow(ev) {
    const iconFor = { plan: 'i-sparkle', tool: 'i-bolt', error: 'i-alert', verify: 'i-check', report: 'i-chart', automation: 'i-bolt' };
    return `<div class="activity-row ${esc(ev.status || 'info')}">
      <div class="activity-ic">${icon(iconFor[ev.kind] || 'i-grid', 'ic ic-sm')}</div>
      <div class="activity-body">
        <div class="activity-title">${esc(ev.title || ev.kind)}</div>
        ${ev.detail ? `<div class="activity-detail">${esc(ev.detail)}</div>` : ''}
        <div class="activity-time">${esc(ev.createdAt ? new Date(ev.createdAt).toLocaleTimeString() : '')}</div>
      </div>
    </div>`;
  }

  // Stream live activity for the open automation. The stream only carries events
  // the runner actually emitted; the UI never invents a step.
  function subscribeAutomationEvents(id) {
    if (state.activitySource) { try { state.activitySource.close(); } catch { /* ignore */ } }
    if (!window.EventSource) return;
    const src = new EventSource(`${API}/api/frontend/events/stream?automation=${encodeURIComponent(id)}`);
    state.activitySource = src;
    src.addEventListener('activity', (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.automationId !== id) return;
        const el = $('autoDetailActivity');
        if (!el) return;
        const empty = el.querySelector('.chat-history-empty');
        if (empty) empty.remove();
        el.insertAdjacentHTML('beforeend', activityRow(ev));
        el.scrollTop = el.scrollHeight;
        if (ev.kind === 'report') {
          // A finished run refreshes the executions list and the card status.
          loadAutomationDetail(id);
          loadAutomations();
        }
      } catch { /* ignore malformed frame */ }
    });
    src.addEventListener('error', () => { /* EventSource retries automatically */ });
  }

  function statusClass(s) {
    if (['running', 'queued', 'starting'].includes(s)) return 'busy';
    if (['completed'].includes(s)) return 'online';
    if (['failed', 'stopped'].includes(s)) return 'offline';
    return 'idle';
  }

  function scheduleLabel(a) {
    if (a.scheduleType === 'once') return 'runs once';
    if (a.scheduleType === 'ai_decided') return 'AI-decided';
    return `every ${a.intervalMinutes || 60}m`;
  }

  function renderAutomationSelect() {
    const sel = $('chatAutoSelect');
    if (!sel) return;
    const opts = ['<option value="">Chat only (no task)</option>']
      .concat(state.automations.map((a) => `<option value="${a.id}" ${a.id === state.activeAutoId ? 'selected' : ''}>${esc(a.name)}</option>`));
    sel.innerHTML = opts.join('');
  }

  /* ============================================================= REPORTS */
  async function renderReports() {
    const list = $('reportsList');
    if (!list) return;
    list.innerHTML = `<div class="report-card"><span class="report-meta">Loading…</span></div>`;
    try {
      const data = await api('/api/frontend/automations');
      const autos = Array.isArray(data.automations) ? data.automations : [];
      if (!autos.length) {
        list.innerHTML = `<div class="empty-state">
          <div class="es-ic">${icon('i-chart')}</div>
          <h3>No executions yet</h3>
          <p>Run an automation and its verified action log and outcome will appear here.</p>
        </div>`;
        return;
      }
      list.innerHTML = autos.map((a) => `
        <div class="report-card">
          <div class="report-top">
            <strong>${esc(a.name)}</strong>
            <span class="pill ${statusClass(a.status || 'idle')}">${esc((a.status || 'idle').replace(/_/g, ' '))}</span>
          </div>
          <div class="report-meta">${esc(a.id)} · ${esc(scheduleLabel(a))} · runs ${a.runCount || 0}</div>
          <p>${esc(a.instructions || 'No instructions recorded')}</p>
          ${a.lastRunAt ? `<div class="report-meta">last run ${esc(new Date(a.lastRunAt).toLocaleString())} · ${esc(a.lastRunStatus || 'n/a')}</div>` : ''}
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button class="btn btn-ghost btn-sm" data-act="open" data-id="${a.id}">${icon('i-chat', 'ic ic-sm')}Open</button>
            <button class="btn btn-primary btn-sm" data-act="run" data-id="${a.id}">${icon('i-play', 'ic ic-sm')}Re-run</button>
          </div>
        </div>`).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty-state">
        <div class="es-ic">${icon('i-alert')}</div>
        <h3>Couldn't load reports</h3>
        <p>${esc(err.message)}</p>
      </div>`;
    }
  }

  /* ============================================================ SETTINGS */
  async function loadSettings() {
    try {
      const data = await api('/api/frontend/settings');
      const s = data.settings || {};
      if ($('cfgGatewayUrl')) $('cfgGatewayUrl').value = s.gatewayUrl || '';
      if ($('cfgProvider')) $('cfgProvider').value = s.provider || 'nvidia';
      if ($('cfgApiKeys')) $('cfgApiKeys').value = '';
      if ($('cfgApiKeys')) $('cfgApiKeys').placeholder = s.hasApiKey
        ? 'Key stored securely — paste a new one to replace'
        : 'nvapi-…';
      if ($('cfgKeyRotation')) $('cfgKeyRotation').checked = s.keyRotation !== false;
      if ($('cfgGitHubRepo')) $('cfgGitHubRepo').value = s.githubRepo || 'Joshbond123/VEXA';
      if ($('cfgGitHubPat')) $('cfgGitHubPat').placeholder = s.hasGitHubPat ? 'Stored securely — paste to replace' : 'ghp_…';
      if ($('cfgCloudflareAccountId')) $('cfgCloudflareAccountId').value = s.cloudflareAccountId || '';
      if ($('cfgCloudflareApiToken')) $('cfgCloudflareApiToken').placeholder = s.hasCloudflareToken ? 'Stored securely' : '…';
      renderProviders(s);
    } catch (err) {
      toast(`Couldn't load settings: ${err.message}`, 'err');
    }
  }

  function renderProviders(s) {
    const list = $('providerStatusList');
    if (!list) return;
    const active = s.provider || 'nvidia';
    list.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `
      <div class="provider-row">
        <div>
          <div class="pr-name">${esc(p.label)}</div>
          <div class="pr-model">${esc(p.model)}</div>
        </div>
        <span class="pill ${id === active ? 'online' : 'idle'}">${id === active ? 'primary' : 'standby'}</span>
      </div>`).join('');
    const stat = $('statProvider');
    if (stat) stat.textContent = (PROVIDERS[active] || PROVIDERS.nvidia).label;
  }

  async function saveSettings(e) {
    e.preventDefault();
    const payload = {
      gatewayUrl: ($('cfgGatewayUrl') || {}).value || '',
      provider: ($('cfgProvider') || {}).value || 'nvidia',
      keyRotation: $('cfgKeyRotation') ? $('cfgKeyRotation').checked : true,
      githubRepo: ($('cfgGitHubRepo') || {}).value || '',
      cloudflareAccountId: ($('cfgCloudflareAccountId') || {}).value || '',
    };
    // Only send secrets when the user actually typed something.
    const keys = ($('cfgApiKeys') || {}).value || '';
    if (keys.trim()) payload.apiKeys = keys.trim();
    const pat = ($('cfgGitHubPat') || {}).value || '';
    if (pat.trim()) payload.githubPat = pat.trim();
    const cf = ($('cfgCloudflareApiToken') || {}).value || '';
    if (cf.trim()) payload.cloudflareApiToken = cf.trim();

    try {
      await api('/api/frontend/settings', { method: 'POST', body: JSON.stringify(payload) });
      const msg = $('settingsSavedMsg');
      if (msg) { msg.textContent = 'Saved'; setTimeout(() => { msg.textContent = ''; }, 2500); }
      toast('Settings saved', 'ok');
      await loadSettings();
      await refreshStatus();
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'err');
    }
  }

  async function testConnection(kind, btn, resultEl) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.3);border-top-color:currentColor"></span>';
    if (resultEl) resultEl.textContent = '';
    try {
      let body;
      if (kind === 'ai') {
        const key = (($('cfgApiKeys') || {}).value || '').trim().split('\n')[0];
        if (!key) throw new Error('Enter an API key first');
        body = { provider: ($('cfgProvider') || {}).value || 'nvidia', apiKey: key };
      } else if (kind === 'github') {
        const pat = (($('cfgGitHubPat') || {}).value || '').trim();
        if (!pat) throw new Error('Enter a GitHub token first');
        body = { githubPat: pat, githubRepo: ($('cfgGitHubRepo') || {}).value || 'Joshbond123/VEXA' };
      } else {
        const id = (($('cfgCloudflareAccountId') || {}).value || '').trim();
        const tok = (($('cfgCloudflareApiToken') || {}).value || '').trim();
        if (!id || !tok) throw new Error('Account ID and token required');
        body = { cloudflareAccountId: id, cloudflareApiToken: tok };
      }
      const data = await api(`/api/settings/test-${kind}`, { method: 'POST', body: JSON.stringify(body) });
      if (data.ok) {
        if (resultEl) { resultEl.textContent = data.message || 'OK'; resultEl.style.color = 'var(--ok)'; }
        toast(data.message || 'Connection OK', 'ok');
      } else {
        if (resultEl) { resultEl.textContent = data.error || 'Failed'; resultEl.style.color = 'var(--bad)'; }
      }
    } catch (err) {
      if (resultEl) { resultEl.textContent = err.message; resultEl.style.color = 'var(--bad)'; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  /* ======================================================= EMULATOR CONTROL */
  async function startEmulator() {
    toast('Starting the Android emulator…', 'info');
    try {
      const data = await api('/api/frontend/emulator/start', { method: 'POST', body: JSON.stringify({}) });
      if (!data.ok) { toast(data.error || 'Could not start emulator', 'err'); return; }
      toast('Emulator booting — this takes 5–10 minutes.', 'ok');
      pollUntilOnline();
    } catch (err) {
      toast(`Could not start emulator: ${err.message}`, 'err');
    }
  }

  function pollUntilOnline() {
    let n = 0;
    const timer = setInterval(async () => {
      n++;
      const d = await refreshStatus();
      if (d.online) { clearInterval(timer); toast('Emulator is online.', 'ok'); }
      else if (n >= 90) { clearInterval(timer); toast('Still booting — check back shortly.', 'warn'); }
    }, 8000);
  }

  async function stopEmulator() {
    if (!confirm('Stop the Android emulator?')) return;
    try {
      const data = await api('/api/frontend/emulator/stop', { method: 'POST', body: JSON.stringify({}) });
      toast(data.message || 'Emulator stopped', 'ok');
      stopStream();
      await refreshStatus();
    } catch (err) {
      toast(`Could not stop emulator: ${err.message}`, 'err');
    }
  }

  /* ================================================================ NAV */
  function showView(name) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    const title = document.querySelector(`.nav-item[data-view="${name}"] span`);
    const t = $('topbarTitle');
    if (t) t.textContent = title ? title.textContent : (name === 'automation' ? 'Automation' : 'Dashboard');
    closeDrawer();
    const main = $('mainContent');
    if (main) main.scrollTop = 0;
    if (name === 'reports') renderReports();
    if (name === 'settings') { loadSettings(); refreshStatus(); }
    if (name === 'automations') loadAutomations();
    // Leaving the automation detail (or any view) closes the activity stream so
    // an idle tab does not hold a connection open.
    if (name !== 'automation' && state.activitySource) {
      try { state.activitySource.close(); } catch { /* ignore */ }
      state.activitySource = null;
    }
  }

  function openDrawer() { $('mobileDrawer').classList.add('open'); $('mobileOverlay').classList.add('open'); }
  function closeDrawer() { $('mobileDrawer').classList.remove('open'); $('mobileOverlay').classList.remove('open'); }

  /* ============================================================ MODAL */
  function openAutoModal(edit) {
    $('autoEditId').value = edit ? edit.id : '';
    $('autoName').value = edit ? edit.name : '';
    $('autoInstructions').value = edit ? edit.instructions : '';
    $('autoScheduleType').value = edit ? (edit.scheduleType || 'once') : 'once';
    $('autoInterval').value = edit ? String(edit.intervalMinutes || 60) : '60';
    $('customIntervalGroup').classList.toggle('hidden', $('autoScheduleType').value !== 'custom');
    $('autoModalTitle').textContent = edit ? 'Edit Automation' : 'New Automation';
    $('autoModal').classList.remove('hidden');
  }
  function closeAutoModal() { $('autoModal').classList.add('hidden'); }

  async function saveAutomation(e) {
    e.preventDefault();
    const id = $('autoEditId').value;
    const intervalRaw = $('autoInterval').value;
    const payload = {
      name: $('autoName').value.trim(),
      instructions: $('autoInstructions').value.trim(),
      scheduleType: $('autoScheduleType').value,
      intervalMinutes: intervalRaw === 'custom' ? Number($('autoCustomMinutes').value) : Number(intervalRaw),
      enabled: true,
      status: 'queued',
      nextRunAt: new Date().toISOString(),
    };
    try {
      if (id) await api(`/api/frontend/automations/${id}`, { method: 'PUT', body: JSON.stringify({ ...payload, id }) });
      else await api('/api/frontend/automations', { method: 'POST', body: JSON.stringify(payload) });
      closeAutoModal();
      await loadAutomations();
      toast('Automation saved', 'ok');
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'err');
    }
  }

  async function automationAction(act, id) {
    const a = state.automations.find((x) => x.id === id);
    if (!a) return;
    if (act === 'run') {
      try {
        await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ automationId: id }) });
        toast('Task dispatched to the agent.', 'ok');
        // Reflect the dispatch immediately and start watching for live events.
        a.status = 'running';
        a.lastRunAt = new Date().toISOString();
        renderAutomations();
        if (state.activeAutoId === id) {
          setPill($('autoDetailStatus'), 'busy', 'running');
          subscribeAutomationEvents(id);
        }
      } catch (err) { toast(`Dispatch failed: ${err.message}`, 'err'); }
    } else if (act === 'open') {
      // Open the automation's own detail view with its real prompt, responses,
      // executions and live activity — never a hardcoded "linked task" label.
      await openAutomation(id);
    } else if (act === 'pause') {
      try {
        await api(`/api/frontend/automations/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...a, paused: !a.paused, status: a.paused ? 'waiting' : 'stopped' }),
        });
        await loadAutomations();
        if (state.activeAutoId === id) await loadAutomationDetail(id);
      } catch (err) { toast(`Update failed: ${err.message}`, 'err'); }
    } else if (act === 'edit') {
      openAutoModal(a);
    } else if (act === 'delete') {
      if (!confirm(`Delete "${a.name}"?`)) return;
      try {
        await api(`/api/frontend/automations/${id}`, { method: 'DELETE' });
        if (state.activeAutoId === id) {
          if (state.activitySource) { try { state.activitySource.close(); } catch { /* ignore */ } state.activitySource = null; }
          state.activeAutoId = '';
          showView('automations');
        }
        await loadAutomations();
        toast('Automation deleted', 'ok');
      } catch (err) { toast(`Delete failed: ${err.message}`, 'err'); }
    }
  }

  /* ================================================================ INIT */
  function bind() {
    document.querySelectorAll('.nav-item').forEach((b) => on(b, 'click', () => showView(b.dataset.view)));
    on($('mobileMenuBtn'), 'click', openDrawer);
    on($('mobileCloseBtn'), 'click', closeDrawer);
    on($('mobileOverlay'), 'click', closeDrawer);
    on($('openSettingsBtn'), 'click', () => showView('settings'));
    on($('refreshTopBtn'), 'click', async () => { await loadAutomations(); await refreshStatus(); toast('Synced', 'ok', 1600); });

    on($('startEmulatorBtn'), 'click', startEmulator);
    on($('mobileStartEmulatorBtn'), 'click', startEmulator);
    on($('overlayStartBtn'), 'click', startEmulator);
    on($('stopEmulatorBtn'), 'click', stopEmulator);
    on($('settingsStartEmuBtn'), 'click', startEmulator);
    on($('settingsStopEmuBtn'), 'click', stopEmulator);

    on($('expandPhoneBtn'), 'click', () => $('phoneStage').classList.toggle('fullscreen'));
    on($('scrollDownBtn'), 'click', () => deviceAction('scroll', { direction: 'down' }));
    document.querySelectorAll('.key-btn[data-key]').forEach((b) => on(b, 'click', () => deviceAction('key', { keycode: Number(b.dataset.key) })));
    on($('manualTypeForm'), 'submit', async (e) => {
      e.preventDefault();
      const input = $('manualTypeInput');
      const v = input.value;
      if (!v) return;
      await deviceAction('type', { text: v });
      input.value = '';
    });

    on($('chatForm'), 'submit', (e) => { e.preventDefault(); sendChat($('chatInput').value); });
    on($('chatInput'), 'input', (e) => autoGrow(e.target));
    on($('chatInput'), 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('chatInput').value); }
    });
    on($('chatClearBtn'), 'click', () => newChat());
    on($('newChatBtn'), 'click', () => newChat());
    on($('chatHistoryToggle'), 'click', () => $('chatHistory')?.classList.toggle('open'));
    on($('chatSearchInput'), 'input', () => renderConversations());
    on($('chatAutoSelect'), 'change', (e) => { state.activeAutoId = e.target.value; });
    document.querySelectorAll('.chip').forEach((c) => on(c, 'click', () => sendChat(c.dataset.prompt)));

    on($('createAutoBtn'), 'click', () => openAutoModal(null));
    on($('autoBackBtn'), 'click', () => showView('automations'));
    on($('autoDetailRunBtn'), 'click', () => { if (state.activeAutoId) automationAction('run', state.activeAutoId); });
    on($('autoDetailPauseBtn'), 'click', () => { if (state.activeAutoId) automationAction('pause', state.activeAutoId); });
    on($('autoForm'), 'submit', saveAutomation);
    on($('autoScheduleType'), 'change', (e) => $('customIntervalGroup').classList.toggle('hidden', e.target.value !== 'custom'));
    document.querySelectorAll('[data-close-modal]').forEach((el) => on(el, 'click', closeAutoModal));
    on($('automationsList'), 'click', (e) => { const b = e.target.closest('[data-act]'); if (b) automationAction(b.dataset.act, b.dataset.id); });
    on($('reportsList'), 'click', (e) => { const b = e.target.closest('[data-act]'); if (b) automationAction(b.dataset.act, b.dataset.id); });
    on($('refreshReportsBtn'), 'click', renderReports);

    on($('settingsForm'), 'submit', saveSettings);
    on($('btnTestAI'), 'click', (e) => testConnection('ai', e.currentTarget, $('aiTestResult')));
    on($('btnTestGitHub'), 'click', (e) => testConnection('github', e.currentTarget, $('githubTestResult')));
    on($('btnTestCloudflare'), 'click', (e) => testConnection('cloudflare', e.currentTarget, $('cloudflareTestResult')));
  }

  async function init() {
    bind();
    setupPhoneInput();
    renderWelcome();
    await loadAutomations();
    await loadConversations();
    await refreshStatus();
    state.statusTimer = setInterval(refreshStatus, STATUS_POLL_MS);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
