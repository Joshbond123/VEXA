/*
 * VEXA — Autonomous AI Android Agent
 * Frontend application logic — Cloudflare Workers Backend
 *
 * Architecture: GitHub Pages (frontend) + Cloudflare Workers (backend)
 *   • Frontend is a static site served by GitHub Pages.
 *   • Backend is Cloudflare Workers at https://vexa-ai-agent.replyraven001.workers.dev
 *   • Data (automations, chats, emulator status, settings) lives in Cloudflare D1 + KV.
 *   • The Android emulator runs in GitHub Actions and registers with Cloudflare gateway.
 *   • The AI agent runs in GitHub Actions and reports back via Cloudflare API.
 *
 * No secrets are bundled, committed, or exposed in frontend code.
 */

(() => {
  'use strict';

  /* ------------------------------------------------------------------ config */
  const CLOUDFLARE_WORKER_URL = 'https://vexa-ai-agent.replyraven001.workers.dev';

  const PROVIDERS = [
    { id: 'nvidia', label: 'NVIDIA NIM', model: 'nemotron-3.5-super-vl-120b-a12b' },
    { id: 'grok',   label: 'xAI Grok',   model: 'grok-2-vision-1212' },
    { id: 'openai', label: 'OpenAI-compatible', model: 'gpt-4o-mini' },
  ];

  /* ------------------------------------------------------------------ state */
  const state = {
    automations: [],
    emulator: { gatewayUrl: '', status: 'offline', deviceModel: '', androidVersion: '', resolution: '', loggedInAccount: '' },
    activeAutoId: null,
    chats: {},
    executions: {},
    settings: {
      gatewayUrl: '',
      provider: 'nvidia',
      keyRotation: true,
    },
    streamTimer: null,
    pointerDown: null,
    providerStatus: {},
    pendingChat: null,
    pollTimer: null,
    authToken: null,
  };

  /* ------------------------------------------------------------------ dom helpers */
  const $ = (id) => document.getElementById(id);
  const on = (el, type, handler) => el && el.addEventListener(type, handler);
  const escapeHtml = (str) => String(str || '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  /* ------------------------------------------------------------------ toast */
  function toast(msg, type = 'info', duration = 4000) {
    const container = $('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type === 'err' ? 'err' : type === 'ok' ? 'ok' : ''}`;
    el.innerHTML = `<div style="flex:1">${escapeHtml(msg)}</div><button class="toast-close" aria-label="Dismiss">✕</button>`;
    container.appendChild(el);
    const dismiss = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); };
    const btn = el.querySelector('.toast-close');
    if (btn) btn.addEventListener('click', dismiss);
    setTimeout(dismiss, duration);
    return el;
  }

  /* ------------------------------------------------------------------ cloudflare workers api */
  async function cfApi(path, options = {}) {
    const url = `${CLOUDFLARE_WORKER_URL}${path}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (state.authToken) {
      headers.Authorization = `Bearer ${state.authToken}`;
    }
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${errText}`);
    }
    return res.json();
  }

  /* ------------------------------------------------------------------ auth */
  async function login(email, password) {
    const data = await cfApi('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (data.ok && data.token) {
      state.authToken = data.token;
      return data;
    }
    throw new Error(data.error || 'Login failed');
  }

  async function verifyToken() {
    if (!state.authToken) return false;
    try {
      const data = await cfApi('/api/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token: state.authToken }),
      });
      return data.valid;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ emulator / device */
  async function checkEmulatorHealth() {
    try {
      const data = await cfApi('/api/frontend/emulator-status');
      const online = data.ok && data.online;
      const cls = `status-pill ${online ? 'online' : 'offline'}`;
      for (const id of ['sidebarEmuStatus', 'mobileEmuStatus']) {
        const el = $(id); if (el) { el.className = cls; el.textContent = online ? 'Online' : 'Offline'; }
      }
      for (const id of ['sidebarEmuMeta', 'mobileEmuMeta']) {
        const el = $(id); if (el) el.textContent = online
          ? `${data.deviceModel || 'Android'} ${data.androidVersion ? '• ' + data.androidVersion : ''}`
          : 'Gateway not configured';
      }
      const overlay = $('phoneOfflineOverlay');
      if (overlay) overlay.classList.toggle('hidden', online);
      const h = $('headerStatusText');
      if (h) h.textContent = online ? 'online' : 'offline';
      const hg = $('headerGateway');
      if (hg) hg.textContent = online ? `Gateway: ${data.deviceModel || 'unknown'}` : 'Gateway: not configured';
      state.emulator.status = online ? 'online' : 'offline';
      if (data.deviceModel) state.emulator.deviceModel = data.deviceModel;
      if (data.androidVersion) state.emulator.androidVersion = data.androidVersion;
      if (data.resolution) state.emulator.resolution = data.resolution;

      if (online) {
        startScreenPolling(data.gatewayUrl || CLOUDFLARE_WORKER_URL);
      }
      return online;
    } catch (err) {
      console.error('Emulator health check failed:', err);
      return false;
    }
  }

  function startScreenPolling(gwUrl) {
    if (state.streamTimer) clearInterval(state.streamTimer);
    const canvas = $('phoneCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) return;
    const pullFrame = async () => {
      try {
        // Use Cloudflare Worker screenshot endpoint
        const res = await fetch(`${CLOUDFLARE_WORKER_URL}/api/emulator/screenshot`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.screenshotUrl) {
          const img = await createImageBitmap(await (await fetch(data.screenshotUrl)).blob());
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          img.close();
        }
      } catch { /* silent retry */ }
    };
    pullFrame();
    state.streamTimer = setInterval(pullFrame, 1500);
  }

  async function sendPhoneAction(action, payload = {}) {
    try {
      await cfApi('/api/emulator/action', {
        method: 'POST',
        body: JSON.stringify({ action, ...payload }),
      });
      const badge = $('phoneLockBadge');
      if (badge) {
        badge.textContent = 'Active';
        badge.className = 'badge status-pill running';
        setTimeout(() => { badge.textContent = 'Idle'; badge.className = 'badge'; }, 1200);
      }
    } catch (err) {
      console.error('Phone action failed:', err);
      toast(`Device action failed: ${err.message}`, 'err');
    }
  }

  function setupPhoneInteraction() {
    const stage = $('phoneStage');
    const canvas = $('phoneCanvas');
    if (!stage || !canvas) return;

    const toDeviceCoords = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * 1080);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * 2400);
      return { x: Math.max(0, Math.min(1080, x)), y: Math.max(0, Math.min(2400, y)) };
    };

    stage.addEventListener('pointerdown', (e) => { state.pointerDown = { ...toDeviceCoords(e), t: Date.now() }; });

    stage.addEventListener('pointerup', (e) => {
      if (!state.pointerDown) return;
      const end = toDeviceCoords(e);
      const dx = Math.abs(end.x - state.pointerDown.x);
      const dy = Math.abs(end.y - state.pointerDown.y);
      if (dx < 20 && dy < 20) {
        sendPhoneAction('tap', { x: end.x, y: end.y });
      } else {
        sendPhoneAction('swipe', { x: state.pointerDown.x, y: state.pointerDown.y, x2: end.x, y2: end.y });
      }
      state.pointerDown = null;
    });

    document.querySelectorAll('.nav-keys button[data-key]').forEach((btn) => {
      on(btn, 'click', () => sendPhoneAction('key', { keycode: Number(btn.dataset.key) }));
    });

    const scrollDown = $('scrollDownBtn');
    if (scrollDown) on(scrollDown, 'click', () => sendPhoneAction('swipe', { x: 540, y: 1700, x2: 540, y2: 700 }));

    on($('manualTypeForm'), 'submit', (e) => {
      e.preventDefault();
      const input = $('manualTypeInput');
      if (!input.value.trim()) return;
      sendPhoneAction('type', { text: input.value });
      input.value = '';
    });

    const expandBtn = $('expandPhoneBtn');
    if (expandBtn) {
      on(expandBtn, 'click', () => {
        const expanded = stage.classList.toggle('expanded');
        expandBtn.innerHTML = expanded
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><line x1="20" y1="7" x2="4" y2="7"/><line x1="4" y1="7" x2="4" y2="20"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H3v5M21 3h5v5M3 16v5M21 16v5h-5"/></svg>';
        expandBtn.title = expanded ? 'Close full screen' : 'Full screen';
      });
    }
  }

  /* ------------------------------------------------------------------ sync & render */
  async function syncAll() {
    setPageLoading(true);
    try {
      const [autos] = await Promise.all([
        cfApi('/api/frontend/automations'),
      ]);
      state.automations = Array.isArray(autos.automations) ? autos.automations : [];
      if (!state.activeAutoId && state.automations.length) state.activeAutoId = state.automations[0].id;
      $('autoCountBadge').textContent = state.automations.length;
      renderAutomations();
      renderChatSelector();
      renderProviderStatus();
      if (state.activeAutoId) await loadAutomationDetails(state.activeAutoId);
      await checkEmulatorHealth();
      startChatPoll();
    } finally {
      setPageLoading(false);
    }
  }

  async function loadAutomationDetails(autoId) {
    const [chat] = await Promise.all([
      cfApi(`/api/frontend/chats/${autoId}`),
    ]);
    state.chats[autoId] = Array.isArray(chat.chats) ? chat.chats : [];
    renderChat();
  }

  /* ------------------------------------------------------------------ chat */
  function renderChatSelector() {
    const sel = $('chatAutoSelect');
    if (!sel) return;
    sel.innerHTML = state.automations.length
      ? state.automations.map((a) => `<option value="${a.id}" ${a.id === state.activeAutoId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')
      : '<option value="">No automations</option>';
    const active = state.automations.find((a) => a.id === state.activeAutoId);
    const statusEl = $('chatAutoStatus');
    if (statusEl) {
      statusEl.className = `status-pill ${active?.status || 'idle'}`;
      statusEl.textContent = active?.status || 'idle';
    }
  }

  function appendMessage(role, content, meta) {
    const box = $('chatMessages');
    if (!box) return;
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = `chat-msg ${role}`;
    el.innerHTML = `<div class="chat-bubble">${escapeHtml(content)}</div><div class="chat-msg-meta">${meta || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function renderChat() {
    const box = $('chatMessages');
    if (!box) return;
    const msgs = state.chats[state.activeAutoId] || [];
    box.innerHTML = '';
    if (!msgs.length) {
      box.innerHTML = '<div class="chat-empty"><div class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="opacity:0.5;"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20"/><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 0 0-6 0"/></svg></div><div style="text-align:center;"><div style="font-weight:600;color:var(--text);margin-bottom:4px;">No messages yet</div><div class="caption">Send an instruction or click Run Now to start the agent on the live device.</div></div></div>';
      return;
    }
    msgs.forEach((m) => appendMessage(m.role, m.content, m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''));
  }

  function addToolStep(label, detail) {
    const box = $('chatMessages');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'chat-tool';
    el.innerHTML = `<div class="tool-step"><div class="tool-icon" aria-hidden="true">▶</div><div><div style="font-weight:600;color:var(--text-2)">${escapeHtml(label)}</div><div style="color:var(--muted)">${escapeHtml(detail || '')}</div></div></div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function setTyping(yes) {
    const btn = $('chatSendBtn');
    if (btn) { btn.disabled = yes; if (yes) btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span>'; else btn.textContent = 'Send'; }
  }

  async function sendChatMessage(text) {
    if (!state.activeAutoId) { toast('Select an automation first.', 'warn'); return; }
    if (!text.trim()) return;

    const input = $('chatInput');
    input.value = '';
    const chat = state.chats[state.activeAutoId] || [];
    const now = new Date().toISOString();
    chat.push({ id: `msg_${uid()}`, role: 'user', content: text, timestamp: now });
    state.chats[state.activeAutoId] = chat;
    appendMessage('user', text, new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    // Save user message to Cloudflare
    await cfApi(`/api/frontend/chats/${state.activeAutoId}`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: text }),
    });

    const lower = text.trim().toLowerCase();
    if (lower === 'pause' || lower === 'stop') {
      // Pause via automation update
      await cfApi(`/api/frontend/automations/${state.activeAutoId}`, {
        method: 'PUT',
        body: JSON.stringify({ paused: true, status: 'stopped' }),
      });
      return;
    }
    if (lower === 'run' || lower === 'run now') {
      await dispatchAgent(state.activeAutoId);
      return;
    }

    // Dispatch agent task via Cloudflare backend
    await dispatchAgent(state.activeAutoId, text);
  }

  async function dispatchAgent(automationId, instructions = null) {
    try {
      const data = await cfApi('/api/agent/run', {
        method: 'POST',
        body: JSON.stringify({ automationId, instructions }),
      });
      if (data.ok) {
        toast('Agent task dispatched to GitHub Actions via Cloudflare backend.', 'ok');
        state.pendingChat = { automationId, message: instructions || '', sentAt: new Date().toISOString() };
        startChatPoll();
      } else {
        toast(data.error || 'Agent dispatch failed', 'err');
      }
    } catch (err) {
      toast(`Agent dispatch failed: ${err.message}`, 'err');
    }
  }

  function startChatPoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (!state.pendingChat) return;
    let polls = 0;
    state.pollTimer = setInterval(async () => {
      polls++;
      if (polls > 120) { clearInterval(state.pollTimer); state.pollTimer = null; return; }
      await checkForAgentResponse();
    }, 5000);
    checkForAgentResponse();
  }

  async function checkForAgentResponse() {
    if (!state.pendingChat || !state.activeAutoId) return;
    const chat = await cfApi(`/api/frontend/chats/${state.activeAutoId}`);
    const msgs = Array.isArray(chat.chats) ? chat.chats : [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'agent' && last.timestamp > (state.pendingChat.sentAt || 0)) {
      state.chats[state.activeAutoId] = msgs;
      state.pendingChat = null;
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
      renderChat();
    }
  }

  /* ------------------------------------------------------------------ automations UI */
  function renderAutomations() {
    const list = $('automationsList');
    if (!list) return;
    if (!state.automations.length) {
      list.innerHTML = '<div class="card" style="grid-column:1/-1;padding:30px;text-align:center;"><div class="empty-icon" style="width:44px;height:44px;margin:0 auto 12px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="opacity:0.4;"><rect x="3" y="11" width="18" height="10" rx="2" ry="2"/><circle cx="12" cy="5" r="2"/><path d="M7 5v10M17 5v10"/></svg></div><h3 style="color:var(--text);margin-bottom:6px;">No automations yet</h3><p class="caption">Create an automation to run autonomous tasks on the live Android device.</p></div>';
      return;
    }
    list.innerHTML = state.automations.map((a) => `
      <div class="auto-card">
        <div class="auto-card-top">
          <h3>${escapeHtml(a.name)}</h3>
          <span class="status-pill ${a.status || 'idle'}">${(a.status || 'idle').replace(/_/g, ' ')}</span>
        </div>
        <p>${escapeHtml(a.instructions)}</p>
        <div class="auto-meta">
          ${a.scheduleType === 'once' ? 'Run once' : a.scheduleType === 'ai_decided' ? 'AI-decided' : `Every ${a.intervalMinutes}m`}
          &#8226; Runs: ${a.runCount || 0}
          ${a.lastRunAt ? `<br>Last: ${new Date(a.lastRunAt).toLocaleString()}` : ''}
        </div>
        <div class="auto-actions">
          <button class="btn btn-primary btn-sm" onclick="window.__vexa.runNow('${a.id}')">Run</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__vexa.openChat('${a.id}')">Chat</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__vexa.togglePause('${a.id}')">${a.paused ? 'Resume' : 'Pause'}</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__vexa.editAuto('${a.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="window.__vexa.deleteAuto('${a.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  }

  function renderReports() {
    const list = $('reportsList');
    if (!list) return;
    // Reports loaded from executions per automation
    list.innerHTML = '<div class="card" style="padding:30px;text-align:center;color:var(--muted)">Execution reports are shown per automation in the chat view.</div>';
  }

  /* ------------------------------------------------------------------ provider status */
  async function renderProviderStatus() {
    const list = $('providerStatusList');
    if (!list) return;
    try {
      const data = await cfApi('/api/frontend/settings');
      const settings = data.settings || {};
      list.innerHTML = PROVIDERS.map((p) => {
        const primary = p.id === settings.provider;
        return `
          <div class="key-row">
            <div style="flex:1;">
              <div style="display:flex;justify-content:space-between;font-weight:600;color:var(--text-2);">
                <span>${escapeHtml(p.label)}</span>
                <span class="status-pill ${primary ? 'online' : 'offline'}">${primary ? 'Primary' : 'Available'}</span>
              </div>
              <div class="caption" style="margin-top:2px;">${escapeHtml(p.model)} &#8226; ${settings.hasApiKey ? 'API key configured' : 'API key not configured'}</div>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="caption">Unable to load provider status.</div>';
    }
  }

  /* ------------------------------------------------------------------ page loading */
  function setPageLoading(yes) {
    document.body.classList.toggle('loading', yes);
  }

  /* ------------------------------------------------------------------ actions */
  window.__vexa = {
    async runNow(id) {
      await dispatchAgent(id);
    },
    openChat(id) {
      state.activeAutoId = id;
      renderChatSelector();
      loadAutomationDetails(id);
      const btn = document.querySelector(`[data-view="dashboard"]`);
      if (btn) btn.click();
    },
    async togglePause(id) {
      const a = state.automations.find((x) => x.id === id);
      if (!a) return;
      a.paused = !a.paused;
      a.status = a.paused ? 'stopped' : 'waiting';
      a.updatedAt = new Date().toISOString();
      await cfApi(`/api/frontend/automations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(a),
      });
      renderAutomations();
      renderChatSelector();
    },
    editAuto(id) {
      const a = state.automations.find((x) => x.id === id);
      if (!a) return;
      $('autoEditId').value = a.id;
      $('autoName').value = a.name;
      $('autoInstructions').value = a.instructions;
      $('autoScheduleType').value = a.scheduleType;
      $('autoInterval').value = String(a.intervalMinutes || 60);
      $('customIntervalGroup').classList.toggle('hidden', $('autoScheduleType').value !== 'custom');
      $('autoModalTitle').textContent = 'Edit Automation';
      $('autoModal').classList.add('open');
    },
    async deleteAuto(id) {
      if (!confirm('Delete this automation?')) return;
      await cfApi(`/api/frontend/automations/${id}`, { method: 'DELETE' });
      state.automations = state.automations.filter((x) => x.id !== id);
      renderAutomations();
      renderChatSelector();
    },
  };

  /* ------------------------------------------------------------------ init */
  function init() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach((btn) => {
      on(btn, 'click', () => {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        btn.classList.add('active');
        const view = $(`view-${btn.dataset.view}`);
        if (view) view.classList.add('active');
        const drawer = $('mobileDrawer');
        const overlay = $('mobileOverlay');
        if (drawer) drawer.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
        if (btn.dataset.view === 'reports') renderReports();
        if (btn.dataset.view === 'settings') renderProviderStatus();
      });
    });

    // Mobile drawer toggle
    const mobileMenuBtn = $('mobileMenuBtn');
    const mobileCloseBtn = $('mobileCloseBtn');
    const mobileOverlay = $('mobileOverlay');
    const mobileDrawer = $('mobileDrawer');
    if (mobileMenuBtn && mobileDrawer && mobileOverlay) {
      on(mobileMenuBtn, 'click', () => { mobileDrawer.classList.add('open'); mobileOverlay.classList.add('open'); });
      const closeDrawer = () => { mobileDrawer.classList.remove('open'); mobileOverlay.classList.remove('open'); };
      on(mobileCloseBtn, 'click', closeDrawer);
      on(mobileOverlay, 'click', closeDrawer);
    }

    // Start emulator via Cloudflare backend (triggers GitHub Actions workflow)
    const startEmu = async () => {
      toast('Starting Android emulator via GitHub Actions...', 'ok');
      // The emulator workflow is triggered separately; we poll for status
      let attempts = 0;
      const pollInterval = setInterval(async () => {
        attempts++;
        const online = await checkEmulatorHealth();
        if (online) {
          clearInterval(pollInterval);
          toast('Android emulator is now online!', 'ok');
        } else if (attempts >= 30) {
          clearInterval(pollInterval);
          toast('Emulator still booting. Check back in a minute.', 'warn');
        }
      }, 4000);
    };
    on($('startEmulatorBtn'), 'click', startEmu);
    on($('overlayStartBtn'), 'click', startEmu);
    on($('mobileStartEmulatorBtn'), 'click', startEmu);
    on($('refreshAllBtn'), 'click', syncAll);
    on($('refreshTopBtn'), 'click', syncAll);

    const openSettingsBtn = $('openSettingsBtn');
    if (openSettingsBtn) on(openSettingsBtn, 'click', () => document.querySelector('[data-view="settings"]').click());

    // New automation modal
    const openNewModal = () => {
      $('autoEditId').value = '';
      $('autoForm').reset();
      $('autoInterval').value = '60';
      $('customIntervalGroup').classList.add('hidden');
      $('autoModalTitle').textContent = 'New Automation';
      $('autoModal').classList.add('open');
    };
    on($('newAutoQuickBtn'), 'click', openNewModal);
    on($('createAutoBtn'), 'click', openNewModal);
    on($('closeAutoModal'), 'click', () => $('autoModal').classList.remove('open'));
    on($('cancelAutoModal'), 'click', () => $('autoModal').classList.remove('open'));

    on($('autoInterval'), 'change', (e) => {
      $('customIntervalGroup').classList.toggle('hidden', e.target.value !== 'custom');
    });

    on($('autoForm'), 'submit', async (e) => {
      e.preventDefault();
      const editId = $('autoEditId').value;
      const scheduleType = $('autoScheduleType').value;
      const intervalVal = $('autoInterval').value;
      const intervalMinutes = intervalVal === 'custom' ? Number($('autoCustomMinutes').value) : Number(intervalVal);
      const now = new Date().toISOString();

      const automation = {
        id: editId || `auto_${Date.now()}`,
        name: $('autoName').value.trim(),
        instructions: $('autoInstructions').value.trim(),
        scheduleType,
        intervalMinutes,
        enabled: true,
        paused: false,
        status: 'queued',
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      };

      if (editId) {
        await cfApi(`/api/frontend/automations/${editId}`, {
          method: 'PUT',
          body: JSON.stringify(automation),
        });
      } else {
        await cfApi('/api/frontend/automations', {
          method: 'POST',
          body: JSON.stringify(automation),
        });
      }
      $('autoModal').classList.remove('open');
      syncAll();
    });

    // Chat selector
    on($('chatAutoSelect'), 'change', (e) => {
      state.activeAutoId = e.target.value;
      loadAutomationDetails(state.activeAutoId);
    });

    on($('chatRunBtn'), 'click', () => state.activeAutoId && window.__vexa.runNow(state.activeAutoId));
    on($('chatPauseBtn'), 'click', () => state.activeAutoId && window.__vexa.togglePause(state.activeAutoId));
    on($('chatStopBtn'), 'click', () => state.activeAutoId && window.__vexa.togglePause(state.activeAutoId));

    // Chat form
    on($('chatForm'), 'submit', async (e) => {
      e.preventDefault();
      const input = $('chatInput');
      const text = input.value.trim();
      if (!text || !state.activeAutoId) return;
      await sendChatMessage(text);
    });

    // Settings
    const cfgGatewayUrl = $('cfgGatewayUrl');
    const cfgProvider = $('cfgProvider');
    const cfgKeyRotation = $('cfgKeyRotation');

    async function loadSettings() {
      try {
        const data = await cfApi('/api/frontend/settings');
        const s = data.settings || {};
        if (cfgGatewayUrl) cfgGatewayUrl.value = s.gatewayUrl || '';
        if (cfgProvider) cfgProvider.value = s.provider || 'nvidia';
        if (cfgKeyRotation) cfgKeyRotation.checked = s.keyRotation !== false;
        state.settings = s;
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    }

    on($('settingsForm'), 'submit', async (e) => {
      e.preventDefault();
      const settings = {
        gatewayUrl: (cfgGatewayUrl ? cfgGatewayUrl.value : '').trim(),
        provider: (cfgProvider ? cfgProvider.value : 'nvidia'),
        keyRotation: cfgKeyRotation ? cfgKeyRotation.checked : true,
      };
      try {
        await cfApi('/api/frontend/settings', {
          method: 'POST',
          body: JSON.stringify(settings),
        });
        state.settings = settings;
        const msg = $('settingsSavedMsg');
        if (msg) { msg.textContent = 'Saved to Cloudflare'; setTimeout(() => { msg.textContent = ''; }, 2500); }
        checkEmulatorHealth();
        renderProviderStatus();
      } catch (err) {
        toast(`Failed to save settings: ${err.message}`, 'err');
      }
    });

    setupPhoneInteraction();
    loadSettings();
    syncAll();
    setInterval(checkEmulatorHealth, 20000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
