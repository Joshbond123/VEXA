/*
 * VEXA — Autonomous AI Android Agent
 * Frontend application logic.
 *
 * Architecture: GitHub Pages (frontend) + GitHub Actions (backend).
 *   • Frontend is a static site served by GitHub Pages.
 *   • The Android emulator + gateway run inside the android-emulator GitHub Action
 *     and publish their public URL to data/emulator.json.
 *   • The AI agent runs inside the agent-runner GitHub Action (cron / dispatch),
 *     using API keys stored as GitHub Secrets (never in frontend code).
 *   • Data (automations, chats, emulator status, settings) lives in the repo's
 *     data/ directory and is read/written via the GitHub API with the user's PAT.
 *
 * No secrets are bundled, committed, or exposed in frontend code.
 */

(() => {
  'use strict';

  /* ------------------------------------------------------------------ config */
  const REPO_OWNER = 'Joshbond123';
  const REPO_NAME = 'VEXA';
  const REPO_BRANCH = 'vexa';

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
      gatewayUrl: localStorage.getItem('vexa.gatewayUrl') || '',
      githubPat: localStorage.getItem('vexa.githubPat') || '',
      provider: localStorage.getItem('vexa.provider') || 'nvidia',
      keyRotation: localStorage.getItem('vexa.keyRotation') !== 'false',
    },
    streamTimer: null,
    pointerDown: null,
    providerStatus: {},
    pendingChat: null,   // { automationId, message } awaiting agent response
    pollTimer: null,
  };

  /* ------------------------------------------------------------------ dom helpers */
  const $ = (id) => document.getElementById(id);
  const on = (el, type, handler) => el && el.addEventListener(type, handler);
  const escapeHtml = (str) => String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  /* ------------------------------------------------------------------ github api (server-side-able via PAT) */
  async function ghReadJson(path, fallback) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${path}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return fallback;
      return await res.json();
    } catch { return fallback; }
  }

  async function ghWriteJson(path, data, message) {
    const pat = state.settings.githubPat;
    if (!pat) { toast('GitHub PAT not configured in Settings. Changes cannot be persisted.', 'err'); return false; }
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
    const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
    let sha;
    const getRes = await fetch(`${apiUrl}?ref=${REPO_BRANCH}`, { headers });
    if (getRes.ok) { const meta = await getRes.json(); sha = meta.sha; }
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + '\n')));
    const putRes = await fetch(apiUrl, {
      method: 'PUT', headers,
      body: JSON.stringify({ message: message || `vexa: update ${path}`, content, branch: REPO_BRANCH, ...(sha ? { sha } : {}) }),
    });
    if (!putRes.ok) {
      const err = await putRes.text().catch(() => '');
      console.error('GitHub write failed:', err);
      toast(`Failed to save to GitHub: ${putRes.status}`, 'err');
      return false;
    }
    return true;
  }

  async function dispatchWorkflow(workflowFile, inputs = {}) {
    const pat = state.settings.githubPat;
    if (!pat) { toast('GitHub PAT not configured. Cannot dispatch workflows.', 'err'); return false; }
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowFile}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: REPO_BRANCH, inputs }),
    });
    if (!res.ok) {
      toast('Workflow dispatch failed (' + res.status + '). Check PAT has actions: write scope.', 'err');
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ emulator / device */
  function getGatewayUrl() {
    return (state.settings.gatewayUrl || state.emulator.gatewayUrl || '').trim().replace(/\/+$/, '');
  }

  async function checkEmulatorHealth() {
    const gw = getGatewayUrl();
    const setStatus = (online, text, device) => {
      const cls = `status-pill ${online ? 'online' : 'offline'}`;
      for (const id of ['sidebarEmuStatus', 'mobileEmuStatus']) { const el = $(id); if (el) { el.className = cls; el.textContent = online ? 'Online' : 'Offline'; } }
      for (const id of ['sidebarEmuMeta', 'mobileEmuMeta']) { const el = $(id); if (el) el.textContent = text; }
      const overlay = $('phoneOfflineOverlay');
      if (overlay) overlay.classList.toggle('hidden', online);
      const h = $('headerStatusText');
      if (h) h.textContent = online ? 'online' : 'offline';
      const hg = $('headerGateway');
      if (hg) hg.textContent = device ? `Gateway: ${device}` : 'Gateway: not configured';
      state.emulator.status = online ? 'online' : 'offline';
      if (device) state.emulator.deviceModel = device;
    };

    if (!gw) { setStatus(false, 'No gateway URL configured'); return; }

    try {
      const res = await fetch(`${gw}/api/public/health`, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(true, `${data.deviceModel || 'Android'} ${data.androidVersion ? '• ' + data.androidVersion : ''} • ${gw.replace(/^https?:\/\//, '')}`, data.deviceModel);
      state.emulator.androidVersion = data.androidVersion || '';
      state.emulator.resolution = data.resolution || '';
      state.emulator.loggedInAccount = data.loggedInAccount || '';
      startScreenPolling(gw);
    } catch (err) {
      setStatus(false, `Unreachable (${err.message})`);
      const reasonEl = $('phoneOfflineReason');
      if (reasonEl) reasonEl.textContent = `Gateway ${gw} is offline or starting. Start the emulator via the GitHub Action or configure the Gateway URL in Settings.`;
    }
  }

  function startScreenPolling(gw) {
    if (state.streamTimer) clearInterval(state.streamTimer);
    const canvas = $('phoneCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) return;
    const pullFrame = async () => {
      try {
        const res = await fetch(`${gw}/api/public/screenshot?t=${Date.now()}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const blob = await res.blob();
        const img = await createImageBitmap(blob);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        img.close();
      } catch { /* silent retry */ }
    };
    pullFrame();
    state.streamTimer = setInterval(pullFrame, 1500);
  }

  async function sendPhoneAction(action, payload = {}) {
    const gw = getGatewayUrl();
    if (!gw) { toast('No gateway URL configured.', 'warn'); return; }
    try {
      await fetch(`${gw}/api/agent/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
        signal: AbortSignal.timeout(25000),
      });
      const badge = $('phoneLockBadge');
      if (badge) { badge.textContent = 'Active'; badge.className = 'badge status-pill running'; setTimeout(() => { badge.textContent = 'Idle'; badge.className = 'badge'; }, 1200); }
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
      const [autos, emu] = await Promise.all([
        ghReadJson('data/automations.json', []),
        ghReadJson('data/emulator.json', { gatewayUrl: '', status: 'offline' }),
      ]);
      state.automations = Array.isArray(autos) ? autos : [];
      state.emulator = emu || { gatewayUrl: '', status: 'offline' };
      if (!state.activeAutoId && state.automations.length) state.activeAutoId = state.automations[0].id;
      // Mirror gateway url into settings if not set
      if (!state.settings.gatewayUrl && state.emulator.gatewayUrl) {
        state.settings.gatewayUrl = state.emulator.gatewayUrl;
        localStorage.setItem('vexa.gatewayUrl', state.settings.gatewayUrl);
      }
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
    const [chat, execs] = await Promise.all([
      ghReadJson(`data/chats/${autoId}.json`, []),
      ghReadJson(`data/executions/${autoId}.json`, []),
    ]);
    state.chats[autoId] = Array.isArray(chat) ? chat : [];
    state.executions[autoId] = Array.isArray(execs) ? execs : [];
    renderChat();
    renderReports();
  }

  /* ------------------------------------------------------------------ chat (async via GitHub Actions agent) */
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
      box.innerHTML = '<div class="chat-empty"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="opacity:0.5;"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20"/><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 0 0-6 0"/></svg></div><div style="text-align:center;"><div style="font-weight:600;color:var(--text);margin-bottom:4px;">No messages yet</div><div class="caption">Send an instruction or click Run Now to start the agent on the live device.</div></div></div>';
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

    // Persist user message
    await ghWriteJson(`data/chats/${state.activeAutoId}.json`, chat, `vexa: chat ${state.activeAutoId}`);

    const lower = text.trim().toLowerCase();
    if (lower === 'pause' || lower === 'stop') { await window.__vexa.togglePause(state.activeAutoId); return; }
    if (lower === 'run' || lower === 'run now') { await window.__vexa.runNow(state.activeAutoId); return; }

    // Queue for the GitHub Actions agent: dispatch the agent-runner workflow.
    // The agent (running with server-side API keys from GitHub Secrets) will
    // process the task and append its response to data/chats/<id>.json.
    const ok = await dispatchWorkflow('agent-runner.yml', { automation_id: state.activeAutoId });
    if (ok) {
      toast('Agent task dispatched to GitHub Actions. It will run with server-side AI keys and report back here.', 'ok');
      state.pendingChat = { automationId: state.activeAutoId, message: text };
      // Start polling for the agent's response
      startChatPoll();
    }
  }

  function startChatPoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (!state.pendingChat) return;
    let polls = 0;
    state.pollTimer = setInterval(async () => {
      polls++;
      if (polls > 120) { clearInterval(state.pollTimer); state.pollTimer = null; return; } // ~10 min max
      await checkForAgentResponse();
    }, 5000);
    checkForAgentResponse();
  }

  async function checkForAgentResponse() {
    if (!state.pendingChat || !state.activeAutoId) return;
    const chat = await ghReadJson(`data/chats/${state.activeAutoId}.json`, []);
    const msgs = Array.isArray(chat) ? chat : [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'agent' && last.timestamp > (state.pendingChat.sentAt || 0)) {
      // New agent response arrived
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
    const all = Object.values(state.executions).flat().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    if (!all.length) {
      list.innerHTML = '<div class="card" style="padding:30px;text-align:center;color:var(--muted)">No execution reports yet. Run an automation to generate reports.</div>';
      return;
    }
    list.innerHTML = all.map((r) => `
      <div class="report-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <strong style="font-size:0.9rem;">${escapeHtml(r.taskReceived || r.task || 'Task')}</strong>
          <span class="status-pill ${r.status || 'unknown'}">${(r.status || 'unknown').replace(/_/g, ' ')}</span>
        </div>
        <div class="report-meta" style="margin-top:4px;">${new Date(r.startedAt).toLocaleString()} &#8226; Apps: ${(r.appsInteracted || []).join(', ') || 'None'} &#8226; Actions: ${(r.actionsPerformed || []).length}</div>
        <p style="margin-top:6px;font-size:0.86rem;color:var(--text-2);white-space:pre-wrap;"><strong>Observed:</strong> ${escapeHtml(r.observedResults || 'N/A')}</p>
        ${r.failures ? `<p style="margin-top:4px;color:#fca5a5;font-size:0.82rem;"><strong>Failures:</strong> ${escapeHtml(r.failures)}</p>` : ''}
      </div>
    `).join('');
  }

  /* ------------------------------------------------------------------ provider status */
  async function renderProviderStatus() {
    const list = $('providerStatusList');
    if (!list) return;
    // We cannot read secret keys from the frontend (they are GitHub Secrets).
    // Show the provider catalog; the agent uses keys from GitHub Secrets.
    list.innerHTML = PROVIDERS.map((p) => {
      const primary = p.id === state.settings.provider;
      return `
        <div class="key-row">
          <div style="flex:1;">
            <div style="display:flex;justify-content:space-between;font-weight:600;color:var(--text-2);">
              <span>${escapeHtml(p.label)}</span>
              <span class="status-pill ${primary ? 'online' : 'offline'}">${primary ? 'Primary' : 'Available'}</span>
            </div>
            <div class="caption" style="margin-top:2px;">${escapeHtml(p.model)} &#8226; API key must be set as a GitHub Secret (NVIDIA_API_KEY / XAI_API_KEY / OPENAI_API_KEY)</div>
          </div>
        </div>
      `;
    }).join('');
  }

  /* ------------------------------------------------------------------ page loading */
  function setPageLoading(yes) {
    document.body.classList.toggle('loading', yes);
  }

  /* ------------------------------------------------------------------ actions */
  window.__vexa = {
    async runNow(id) {
      const ok = await dispatchWorkflow('agent-runner.yml', { automation_id: id });
      if (ok) toast('Agent execution dispatched to GitHub Actions.', 'ok');
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
      await ghWriteJson('data/automations.json', state.automations, `vexa: ${a.paused ? 'pause' : 'resume'} ${a.name}`);
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
      state.automations = state.automations.filter((x) => x.id !== id);
      await ghWriteJson('data/automations.json', state.automations, 'vexa: delete automation');
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

    // Start emulator (desktop + mobile)
    const startEmu = async () => {
      const ok = await dispatchWorkflow('android-emulator.yml');
      if (ok) toast('Android Emulator workflow dispatched. The device will boot in ~2 minutes and the gateway URL will appear here.', 'ok');
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

      if (editId) {
        const a = state.automations.find((x) => x.id === editId);
        if (a) {
          a.name = $('autoName').value.trim();
          a.instructions = $('autoInstructions').value.trim();
          a.scheduleType = scheduleType;
          a.intervalMinutes = intervalMinutes;
          a.updatedAt = now;
        }
      } else {
        const newAuto = {
          id: `auto_${Date.now()}`,
          name: $('autoName').value.trim(),
          instructions: $('autoInstructions').value.trim(),
          scheduleType,
          intervalMinutes,
          enabled: true,
          paused: false,
          status: 'queued',
          nextRunAt: now,
          lastRunAt: null,
          runCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        state.automations.unshift(newAuto);
        state.activeAutoId = newAuto.id;
      }

      await ghWriteJson('data/automations.json', state.automations, 'vexa: save automation');
      $('autoModal').classList.remove('open');
      renderAutomations();
      renderChatSelector();
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
    const cfgGithubPat = $('cfgGithubPat');
    const cfgProvider = $('cfgProvider');
    const cfgKeyRotation = $('cfgKeyRotation');

    if (cfgGatewayUrl) cfgGatewayUrl.value = state.settings.gatewayUrl;
    if (cfgGithubPat) cfgGithubPat.value = state.settings.githubPat;
    if (cfgProvider) cfgProvider.value = state.settings.provider;
    if (cfgKeyRotation) cfgKeyRotation.checked = state.settings.keyRotation;

    on($('settingsForm'), 'submit', (e) => {
      e.preventDefault();
      state.settings.gatewayUrl = (cfgGatewayUrl ? cfgGatewayUrl.value : '').trim();
      state.settings.githubPat = (cfgGithubPat ? cfgGithubPat.value : '').trim();
      if (cfgProvider) state.settings.provider = cfgProvider.value;
      state.settings.keyRotation = cfgKeyRotation ? cfgKeyRotation.checked : true;
      localStorage.setItem('vexa.gatewayUrl', state.settings.gatewayUrl);
      localStorage.setItem('vexa.githubPat', state.settings.githubPat);
      localStorage.setItem('vexa.provider', state.settings.provider);
      localStorage.setItem('vexa.keyRotation', state.settings.keyRotation);
      // Persist settings to repo (PAT-protected). AI keys are NOT stored here —
      // they must be GitHub Secrets (NVIDIA_API_KEY, XAI_API_KEY, OPENAI_API_KEY).
      (async () => {
        await ghWriteJson('data/settings.json', {
          gatewayUrl: state.settings.gatewayUrl,
          provider: state.settings.provider,
          keyRotation: state.settings.keyRotation,
          updatedAt: new Date().toISOString(),
        }, 'vexa: save settings');
      })();
      const msg = $('settingsSavedMsg');
      if (msg) { msg.textContent = 'Saved'; setTimeout(() => { msg.textContent = ''; }, 2500); }
      checkEmulatorHealth();
      renderProviderStatus();
    });

    setupPhoneInteraction();
    syncAll();
    setInterval(checkEmulatorHealth, 20000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
