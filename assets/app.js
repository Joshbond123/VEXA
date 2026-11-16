(() => {
  const REPO_OWNER = 'Joshbond123';
  const REPO_NAME = 'VEXA';
  const REPO_BRANCH = 'vexa';

  const state = {
    automations: [],
    emulator: { gatewayUrl: '', status: 'offline' },
    activeAutoId: null,
    chats: {},
    executions: {},
    settings: {
      gatewayUrl: localStorage.getItem('vexa.gatewayUrl') || '',
      githubPat: localStorage.getItem('vexa.githubPat') || '',
      nvidiaKey: localStorage.getItem('vexa.nvidiaKey') || '',
    },
    streamTimer: null,
    pointerDown: null,
  };

  const $ = (id) => document.getElementById(id);

  // --- GitHub Repo Storage Helpers ---
  async function ghReadJson(path, fallback) {
    try {
      const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${path}?t=${Date.now()}`;
      const res = await fetch(url);
      if (!res.ok) return fallback;
      return await res.json();
    } catch {
      return fallback;
    }
  }

  async function ghWriteJson(path, data, message) {
    const pat = state.settings.githubPat;
    if (!pat) {
      alert('Please configure your GitHub PAT in Settings & Secrets to persist changes.');
      return false;
    }
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };

    let sha = undefined;
    const getRes = await fetch(`${apiUrl}?ref=${REPO_BRANCH}`, { headers });
    if (getRes.ok) {
      const meta = await getRes.json();
      sha = meta.sha;
    }

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + '\n')));
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: message || `vexa: update ${path}`,
        content,
        branch: REPO_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      console.error('GitHub write failed:', err);
      alert(`Failed to save ${path} to GitHub: ${putRes.status}`);
      return false;
    }
    return true;
  }

  async function dispatchWorkflow(workflowFile, inputs = {}) {
    const pat = state.settings.githubPat;
    if (!pat) {
      alert('Please configure your GitHub PAT in Settings & Secrets to trigger workflows.');
      return false;
    }
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowFile}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REPO_BRANCH, inputs }),
    });
    if (!res.ok) {
      alert(`Workflow dispatch failed (${res.status}). Ensure PAT has workflow scope.`);
      return false;
    }
    return true;
  }

  // --- Sync & Render ---
  async function syncAll() {
    const [autos, emu] = await Promise.all([
      ghReadJson('data/automations.json', []),
      ghReadJson('data/emulator.json', { gatewayUrl: '', status: 'offline' }),
    ]);
    state.automations = Array.isArray(autos) ? autos : [];
    state.emulator = emu || { gatewayUrl: '', status: 'offline' };

    if (!state.activeAutoId && state.automations.length) {
      state.activeAutoId = state.automations[0].id;
    }

    $('autoCountBadge').textContent = state.automations.length;
    renderAutomations();
    renderChatSelector();
    if (state.activeAutoId) {
      await loadAutomationDetails(state.activeAutoId);
    }
    checkEmulatorHealth();
  }

  async function loadAutomationDetails(autoId) {
    const [chat, execs] = await Promise.all([
      ghReadJson(`data/chats/${autoId}.json`, []),
      ghReadJson(`data/executions/${autoId}.json`, []),
    ]);
    state.chats[autoId] = chat;
    state.executions[autoId] = execs;
    renderChat();
    renderReports();
  }

  // --- Live Emulator Streaming & Controls ---
  function getGatewayUrl() {
    return (state.settings.gatewayUrl || state.emulator.gatewayUrl || '').trim().replace(/\/$/, '');
  }

  async function checkEmulatorHealth() {
    const gw = getGatewayUrl();
    const setStatus = (online, text) => {
      const cls = `status-pill ${online ? 'online' : 'offline'}`;
      $('sidebarEmuStatus').className = cls;
      $('sidebarEmuStatus').textContent = online ? 'Online' : 'Offline';
      $('mobileStatusPill').className = cls;
      $('mobileStatusPill').textContent = online ? 'Online' : 'Offline';
      $('sidebarEmuMeta').textContent = text;
      $('phoneOfflineOverlay').classList.toggle('hidden', online);
    };

    if (!gw) {
      setStatus(false, 'No gateway URL configured');
      return;
    }

    try {
      const res = await fetch(`${gw}/api/public/health`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(true, `${data.deviceModel || 'Android'} • ${gw.replace(/^https?:\/\//, '')}`);
      startScreenPolling(gw);
    } catch (err) {
      setStatus(false, `Unreachable (${err.message})`);
      $('phoneOfflineReason').textContent = `Gateway ${gw} is offline or starting. Click Start Emulator to boot via GitHub Actions.`;
    }
  }

  function startScreenPolling(gw) {
    if (state.streamTimer) clearInterval(state.streamTimer);
    const canvas = $('phoneCanvas');
    const ctx = canvas.getContext('2d');

    const pullFrame = async () => {
      try {
        const res = await fetch(`${gw}/api/public/screenshot?t=${Date.now()}`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const blob = await res.blob();
        const img = await createImageBitmap(blob);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        img.close();
      } catch {}
    };

    pullFrame();
    state.streamTimer = setInterval(pullFrame, 1000);
  }

  async function sendPhoneAction(action, payload = {}) {
    const gw = getGatewayUrl();
    if (!gw) return;
    try {
      await fetch(`${gw}/api/agent/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
    } catch (err) {
      console.error('Phone action failed:', err);
    }
  }

  function setupPhoneInteraction() {
    const stage = $('phoneStage');
    const canvas = $('phoneCanvas');

    const toDeviceCoords = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * 1080);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * 2400);
      return { x: Math.max(0, Math.min(1080, x)), y: Math.max(0, Math.min(2400, y)) };
    };

    stage.addEventListener('pointerdown', (e) => {
      state.pointerDown = { ...toDeviceCoords(e), t: Date.now() };
    });

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
      btn.addEventListener('click', () => sendPhoneAction('key', { keycode: Number(btn.dataset.key) }));
    });

    $('scrollDownBtn').addEventListener('click', () => sendPhoneAction('swipe', { x: 540, y: 1700, x2: 540, y2: 700 }));
    $('scrollUpBtn').addEventListener('click', () => sendPhoneAction('swipe', { x: 540, y: 700, x2: 540, y2: 1700 }));

    $('manualTypeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('manualTypeInput');
      if (!input.value.trim()) return;
      sendPhoneAction('type', { text: input.value });
      input.value = '';
    });

    $('expandPhoneBtn').addEventListener('click', () => {
      stage.classList.toggle('expanded');
      $('expandPhoneBtn').textContent = stage.classList.contains('expanded') ? '✕ Close' : '⤢ Expand';
    });
  }

  // --- Automations UI ---
  function renderAutomations() {
    const list = $('automationsList');
    if (!state.automations.length) {
      list.innerHTML = `<div class="card" style="padding:24px;grid-column:1/-1;text-align:center;color:var(--muted)">No automations yet. Click <strong>+ Create Automation</strong> to get started.</div>`;
      return;
    }

    list.innerHTML = state.automations.map((a) => `
      <div class="auto-card">
        <div class="auto-card-top">
          <h3>${escapeHtml(a.name)}</h3>
          <span class="status-pill ${a.status || 'idle'}">${a.status || 'idle'}</span>
        </div>
        <p>${escapeHtml(a.instructions)}</p>
        <div class="auto-meta">
          Schedule: ${a.scheduleType === 'once' ? 'Run Once' : a.scheduleType === 'ai_decided' ? 'AI-Decided' : `Every ${a.intervalMinutes}m`}
          • Runs: ${a.runCount || 0}
          ${a.nextRunAt ? `<br>Next: ${new Date(a.nextRunAt).toLocaleString()}` : ''}
        </div>
        <div class="auto-actions">
          <button class="btn btn-primary btn-sm" onclick="window.__vexa.runNow('${a.id}')">▶ Run</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__vexa.openChat('${a.id}')">💬 Chat</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__vexa.togglePause('${a.id}')">${a.paused ? '▶ Resume' : '⏸ Pause'}</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__vexa.editAuto('${a.id}')">✎ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="window.__vexa.deleteAuto('${a.id}')">🗑</button>
        </div>
      </div>
    `).join('');
  }

  function renderChatSelector() {
    const sel = $('chatAutoSelect');
    sel.innerHTML = state.automations.length
      ? state.automations.map((a) => `<option value="${a.id}" ${a.id === state.activeAutoId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')
      : '<option value="">No automations</option>';
    const active = state.automations.find((a) => a.id === state.activeAutoId);
    $('chatAutoStatus').className = `status-pill ${active?.status || 'idle'}`;
    $('chatAutoStatus').textContent = active?.status || 'idle';
  }

  function renderChat() {
    const box = $('chatMessages');
    const msgs = state.chats[state.activeAutoId] || [];
    if (!msgs.length) {
      box.innerHTML = '<div class="chat-empty">No messages yet. Send instructions or click Run Now to start.</div>';
      return;
    }
    box.innerHTML = msgs.map((m) => `
      <div class="chat-msg ${m.role}">
        <div>${escapeHtml(m.content)}</div>
        <div class="chat-msg-meta">${new Date(m.timestamp).toLocaleTimeString()}</div>
      </div>
    `).join('');
    box.scrollTop = box.scrollHeight;
  }

  function renderReports() {
    const list = $('reportsList');
    const allExecs = Object.values(state.executions).flat().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    if (!allExecs.length) {
      list.innerHTML = '<div class="card" style="padding:24px;color:var(--muted)">No execution reports recorded yet.</div>';
      return;
    }
    list.innerHTML = allExecs.map((r) => `
      <div class="report-card">
        <div class="auto-card-top">
          <strong>${escapeHtml(r.taskReceived)}</strong>
          <span class="status-pill ${r.status}">${r.status}</span>
        </div>
        <div class="auto-meta" style="margin:6px 0">${new Date(r.startedAt).toLocaleString()} • Apps: ${(r.appsInteracted || []).join(', ') || 'None'}</div>
        <p style="font-size:0.86rem;margin-top:6px"><strong>Observed:</strong> ${escapeHtml(r.observedResults || 'N/A')}</p>
        ${r.failures ? `<p style="font-size:0.86rem;color:var(--rose);margin-top:4px"><strong>Failures:</strong> ${escapeHtml(r.failures)}</p>` : ''}
      </div>
    `).join('');
  }

  // --- Actions ---
  window.__vexa = {
    async runNow(id) {
      const ok = await dispatchWorkflow('agent-runner.yml', { automation_id: id });
      if (ok) alert('Agent execution dispatched to GitHub Actions! Check back shortly for the report.');
    },
    openChat(id) {
      state.activeAutoId = id;
      renderChatSelector();
      loadAutomationDetails(id);
      document.querySelector('[data-view="dashboard"]').click();
    },
    async togglePause(id) {
      const a = state.automations.find((x) => x.id === id);
      if (!a) return;
      a.paused = !a.paused;
      a.status = a.paused ? 'stopped' : 'waiting';
      a.updatedAt = new Date().toISOString();
      await ghWriteJson('data/automations.json', state.automations, `vexa: ${a.paused ? 'pause' : 'resume'} ${a.name}`);
      renderAutomations();
    },
    editAuto(id) {
      const a = state.automations.find((x) => x.id === id);
      if (!a) return;
      $('autoEditId').value = a.id;
      $('autoName').value = a.name;
      $('autoInstructions').value = a.instructions;
      $('autoScheduleType').value = a.scheduleType;
      $('autoModalTitle').textContent = 'Edit Automation';
      $('autoModal').classList.remove('hidden');
    },
    async deleteAuto(id) {
      if (!confirm('Delete this automation?')) return;
      state.automations = state.automations.filter((x) => x.id !== id);
      await ghWriteJson('data/automations.json', state.automations, `vexa: delete automation ${id}`);
      renderAutomations();
      renderChatSelector();
    },
  };

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Event Listeners ---
  function init() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        btn.classList.add('active');
        $(`view-${btn.dataset.view}`).classList.add('active');
        $('sidebar').classList.remove('open');
      });
    });

    $('mobileMenuBtn').addEventListener('click', () => $('sidebar').classList.add('open'));
    $('closeSidebarBtn').addEventListener('click', () => $('sidebar').classList.remove('open'));
    $('refreshAllBtn').addEventListener('click', syncAll);

    // Start Emulator
    const startEmu = async () => {
      const ok = await dispatchWorkflow('android-emulator.yml');
      if (ok) alert('Android Emulator workflow dispatched! It will boot in ~2-3 minutes.');
    };
    $('startEmulatorBtn').addEventListener('click', startEmu);
    $('overlayStartBtn').addEventListener('click', startEmu);

    // Modal
    const openNewModal = () => {
      $('autoEditId').value = '';
      $('autoForm').reset();
      $('autoModalTitle').textContent = 'New Automation';
      $('autoModal').classList.remove('hidden');
    };
    $('newAutoQuickBtn').addEventListener('click', openNewModal);
    $('createAutoBtn').addEventListener('click', openNewModal);
    $('closeAutoModal').addEventListener('click', () => $('autoModal').classList.add('hidden'));
    $('cancelAutoModal').addEventListener('click', () => $('autoModal').classList.add('hidden'));

    $('autoInterval').addEventListener('change', (e) => {
      $('customIntervalGroup').classList.toggle('hidden', e.target.value !== 'custom');
    });

    $('autoForm').addEventListener('submit', async (e) => {
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
      $('autoModal').classList.add('hidden');
      renderAutomations();
      renderChatSelector();
    });

    // Chat
    $('chatAutoSelect').addEventListener('change', (e) => {
      state.activeAutoId = e.target.value;
      loadAutomationDetails(state.activeAutoId);
    });

    $('chatRunNowBtn').addEventListener('click', () => state.activeAutoId && window.__vexa.runNow(state.activeAutoId));
    $('chatPauseBtn').addEventListener('click', () => state.activeAutoId && window.__vexa.togglePause(state.activeAutoId));
    $('chatStopBtn').addEventListener('click', () => state.activeAutoId && window.__vexa.togglePause(state.activeAutoId));

    $('chatForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.activeAutoId) return;
      const input = $('chatInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';

      const chat = state.chats[state.activeAutoId] || [];
      chat.push({ id: `msg_${Date.now()}`, role: 'user', content: text, timestamp: new Date().toISOString() });

      const lower = text.toLowerCase();
      if (lower === 'pause' || lower === 'stop') {
        await window.__vexa.togglePause(state.activeAutoId);
      } else if (lower === 'run' || lower === 'run now') {
        await window.__vexa.runNow(state.activeAutoId);
      }

      await ghWriteJson(`data/chats/${state.activeAutoId}.json`, chat, `vexa: chat update ${state.activeAutoId}`);
      state.chats[state.activeAutoId] = chat;
      renderChat();
    });

    // Settings
    $('cfgGatewayUrl').value = state.settings.gatewayUrl;
    $('cfgGithubPat').value = state.settings.githubPat;
    $('cfgNvidiaKey').value = state.settings.nvidiaKey;

    $('settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      state.settings.gatewayUrl = $('cfgGatewayUrl').value.trim();
      state.settings.githubPat = $('cfgGithubPat').value.trim();
      state.settings.nvidiaKey = $('cfgNvidiaKey').value.trim();
      localStorage.setItem('vexa.gatewayUrl', state.settings.gatewayUrl);
      localStorage.setItem('vexa.githubPat', state.settings.githubPat);
      localStorage.setItem('vexa.nvidiaKey', state.settings.nvidiaKey);
      $('settingsSavedMsg').textContent = '✓ Saved locally';
      checkEmulatorHealth();
    });

    setupPhoneInteraction();
    syncAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
