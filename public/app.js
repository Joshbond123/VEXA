const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (res.status === 401) { showLogin(); throw new Error('Authentication required'); }
  if (!res.ok) {
    const message = data?.error?.message || data?.error || `Request failed (${res.status})`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data;
}

const fmt = {
  bytes(n) {
    if (!Number.isFinite(Number(n)) || Number(n) <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Number(n); let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  },
  hours(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
    return (Number(seconds) / 3600).toFixed(1);
  },
  when(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  },
  dur(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return '—';
    const s = Math.floor(Number(ms) / 1000);
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  },
};

const state = { view: 'overview', timers: [], overview: null, gpu: null, settings: null, lastKey: null };

function clearTimers() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
}

function showLogin() {
  clearTimers();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = '';
}

function showApp(operator) {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#operator').textContent = operator?.username || '';
  navigate('overview');
}

function navigate(view) {
  state.view = view;
  for (const btn of document.querySelectorAll('.nav')) {
    if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  clearTimers();
  if (view === 'overview') { loadOverview(); state.timers.push(setInterval(loadOverview, 8000)); }
  if (view === 'gpu') { loadGpu(); state.timers.push(setInterval(loadGpu, 5000)); }
  if (view === 'keys') loadKeys();
  if (view === 'logs') { loadLogs(); state.timers.push(setInterval(loadLogs, 10000)); }
  if (view === 'settings') loadSettings();
}

function card(title, ...kids) {
  return el('div', { class: 'card' }, el('h3', { text: title }), ...kids);
}

function setPill(gpu) {
  const status = gpu?.status || 'off';
  const pill = $('#gpu-pill');
  pill.dataset.state = status;
  pill.textContent = status;
}

async function loadOverview() {
  try {
    const data = await api('/api/overview');
    state.overview = data;
    state.gpu = data.gpu;
    setPill(data.gpu);
    renderOverview(data);
  } catch (err) {
    if (!/Authentication/.test(err.message)) {
      $('#view-overview').replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  }
}

function renderOverview(data) {
  const gpu = data.gpu || { status: 'off' };
  const quota = data.quota || {};
  const usage = data.usage || {};
  const total = quota.gpu?.totalSeconds || 0;
  const used = quota.gpu?.usedSeconds || 0;
  const remaining = usage.remainingSeconds ?? Math.max(0, total - used);
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;

  const gpuCard = card('GPU runtime',
    el('div', { class: 'spread' },
      el('div', { class: 'metric', text: gpu.status || 'off', 'data-state': gpu.status }),
      el('span', { class: 'muted', text: gpu.phase || '' })),
    el('div', { class: 'bar' }, el('i', { style: `width:${Math.max(0, Math.min(100, Number(gpu.progress) || 0))}%` })),
    el('dl', { class: 'kv' },
      el('dt', { text: 'Detail' }), el('dd', { text: gpu.detail || '—' }),
      el('dt', { text: 'Session' }), el('dd', { text: gpu.sessionId || '—' }),
      el('dt', { text: 'Uptime' }), el('dd', { text: gpu.readyAt ? fmt.dur(Date.now() - gpu.readyAt) : '—' }),
      el('dt', { text: 'Kernel' }), el('dd', { text: gpu.kernelVersion || '—' })),
    gpu.error ? el('p', { class: 'error', text: gpu.error }) : null);
  const quotaCard = card('Kaggle GPU quota',
    el('div', { class: 'metric' }, `${fmt.hours(used)} `, el('small', { text: `/ ${fmt.hours(total)} h used` })),
    el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` })),
    el('p', { class: 'muted', text: `${fmt.hours(remaining)} h remaining · resets ${quota.refreshAt ? new Date(quota.refreshAt).toLocaleDateString() : '—'}` }),
    el('p', { class: 'hint', text: 'T4 sessions cap at 12 h; the runtime shuts down when idle.' }));

  const ds = data.dataset || {};
  const datasetCard = card('Model dataset',
    el('div', { class: 'metric' }, fmt.bytes(ds.totalBytes), ' ', el('small', { text: ds.isPrivate ? 'private' : 'public' })),
    el('dl', { class: 'kv' },
      el('dt', { text: 'Ref' }), el('dd', { text: ds.ref || '—' }),
      el('dt', { text: 'Version' }), el('dd', { text: ds.version ? `v${ds.version}` : '—' }),
      el('dt', { text: 'Updated' }), el('dd', { text: ds.lastUpdated ? fmt.when(ds.lastUpdated) : '—' })),
    ds.error ? el('p', { class: 'error', text: ds.error }) : null);

  const settings = data.settings || {};
  const endpointCard = card('OpenAI endpoint',
    el('div', { class: 'metric', text: '/v1' }),
    el('dl', { class: 'kv' },
      el('dt', { text: 'Model' }), el('dd', { text: settings.model_served_id || '—' }),
      el('dt', { text: 'Context' }), el('dd', { text: settings.ctx_size ? `${settings.ctx_size} tokens` : '—' }),
      el('dt', { text: 'Slots' }), el('dd', { text: settings.parallel_slots || '—' }),
      el('dt', { text: 'Idle stop' }), el('dd', { text: settings.idle_timeout_minutes ? `${settings.idle_timeout_minutes} min` : '—' })),
    el('p', { class: 'hint', text: 'Bearer API key required. Streaming and non-streaming chat completions.' }));
  const events = (data.events || []).slice(0, 8);
  const eventsCard = card('Recent activity',
    el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Kind' }), el('th', { text: 'Message' }))),
        el('tbody', {}, events.map((row) => el('tr', {},
          el('td', { class: 'mono', text: fmt.when(row.ts) }),
          el('td', { text: row.kind }),
          el('td', { text: row.message })))))));

  const live = ['starting', 'loading', 'ready', 'busy'].includes(gpu.status);
  const actions = el('div', { class: 'row' },
    el('button', { class: 'primary', text: live ? 'Restart GPU' : 'Start GPU', onclick: () => gpuAction('/api/gpu/start') }),
    el('button', { class: 'danger', text: 'Stop GPU', disabled: !live, onclick: () => gpuAction('/api/gpu/stop') }),
    el('button', { class: 'ghost', text: 'Hold 30 min', disabled: !live, onclick: () => gpuAction('/api/gpu/hold', { minutes: 30 }) }),
    el('span', { class: 'hint', text: 'Starting a session pushes the runtime kernel and waits for it to register.' }));

  $('#view-overview').replaceChildren(
    el('div', { class: 'spread' },
      el('h2', { text: 'Control plane' }),
      el('span', { class: 'muted', text: `updated ${new Date().toLocaleTimeString()}` })),
    el('div', { class: 'grid' }, gpuCard, quotaCard, datasetCard, endpointCard),
    actions,
    eventsCard);
}

async function gpuAction(path, body = {}) {
  try {
    await api(path, { method: 'POST', body });
    await loadOverview();
  } catch (err) {
    alert(err.message);
  }
}

async function loadGpu() {
  try {
    const [gpu, logs] = await Promise.all([api('/api/gpu'), api('/api/gpu/logs')]);
    state.gpu = gpu;
    setPill(gpu);
    renderGpu(gpu, logs.lines || []);
  } catch (err) {
    if (!/Authentication/.test(err.message)) {
      $('#view-gpu').replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  }
}

function fmtGpus(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  if (!list.length) return '—';
  return list.map((g) => {
    const name = g.name || `GPU ${g.index ?? 0}`;
    const mem = g.totalMiB ? ` ${Math.round(g.usedMiB || 0)}/${Math.round(g.totalMiB)} MiB` : '';
    const util = g.utilPct != null ? ` · ${Math.round(g.utilPct)}%` : '';
    return name + mem + util;
  }).join(' | ');
}

function metricsCard(gpu) {
  const m = gpu.metrics || {};
  const model = gpu.model || {};
  return card('Model',
    el('div', { class: 'metric', text: model.id || '—' }),
    el('dl', { class: 'kv' },
      el('dt', { text: 'Context' }), el('dd', { text: model.ctx ? `${model.ctx} tokens` : '—' }),
      el('dt', { text: 'Slots' }), el('dd', { text: model.parallel ?? '—' }),
      el('dt', { text: 'VRAM' }), el('dd', { text: model.vramMiB ? `${model.vramMiB} MiB` : '—' }),
      el('dt', { text: 'First token' }), el('dd', { text: m.ttftMs ? `${Math.round(m.ttftMs)} ms` : '—' }),
      el('dt', { text: 'Throughput' }), el('dd', { text: m.tokPerSec ? `${m.tokPerSec} tok/s` : '—' })),
    el('p', { class: 'hint', text: 'Measured by the runtime self-test right after the weights load.' }));
}

function renderGpu(gpu, lines) {
  const detail = card('Session state',
    el('dl', { class: 'kv' },
      el('dt', { text: 'Status' }), el('dd', { text: gpu.status || 'off' }),
      el('dt', { text: 'Phase' }), el('dd', { text: gpu.phase || '—' }),
      el('dt', { text: 'Detail' }), el('dd', { text: gpu.detail || '—' }),
      el('dt', { text: 'Session id' }), el('dd', { text: gpu.sessionId || '—' }),
      el('dt', { text: 'Nonce' }), el('dd', { text: gpu.nonce || '—' }),
      el('dt', { text: 'Kernel version' }), el('dd', { text: gpu.kernelVersion || '—' }),
      el('dt', { text: 'Heartbeat' }), el('dd', { text: gpu.lastHeartbeat ? `${fmt.dur(Date.now() - gpu.lastHeartbeat)} ago` : '—' }),
      el('dt', { text: 'Ready at' }), el('dd', { text: gpu.readyAt ? fmt.when(gpu.readyAt) : '—' }),
      el('dt', { text: 'Active jobs' }), el('dd', { text: String(gpu.activeJobs ?? 0) }),
      el('dt', { text: 'GPUs' }), el('dd', { text: fmtGpus(gpu.gpus) })),
    el('div', { class: 'bar' }, el('i', { style: `width:${Math.max(0, Math.min(100, Number(gpu.progress) || 0))}%` })),
    gpu.error ? el('p', { class: 'error', text: gpu.error }) : null);
  const logPre = el('pre', { class: 'logs' },
    lines.length
      ? lines.map((line) => el('span', {
          class: line.level === 'error' ? 'error' : line.level === 'warn' ? 'warn' : '',
          text: `${new Date(line.ts).toLocaleTimeString()}  ${line.message}\n`,
        }))
      : el('span', { class: 'muted', text: 'No runtime output yet. Start the GPU to stream kernel logs here.' }));

  const logsCard = card('Runtime log', logPre,
    el('p', { class: 'hint', text: 'Tail of the kernel output, delivered over the runtime heartbeat.' }));

  const live = ['starting', 'loading', 'ready', 'busy'].includes(gpu.status);
  const actions = el('div', { class: 'row' },
    el('button', { class: 'primary', text: 'Start GPU', disabled: live, onclick: () => gpuAction('/api/gpu/start') }),
    el('button', { class: 'danger', text: 'Stop GPU', disabled: !live, onclick: () => gpuAction('/api/gpu/stop') }));

  $('#view-gpu').replaceChildren(
    el('div', { class: 'spread' }, el('h2', { text: 'GPU runtime' }), el('span', { class: 'muted', text: 'auto-refresh 5s' })),
    el('div', { class: 'grid' }, detail, metricsCard(gpu)),
    actions,
    logsCard);
  logPre.scrollTop = logPre.scrollHeight;
}

async function loadKeys() {
  try {
    const [data, cfg] = await Promise.all([api('/api/keys'), api('/api/settings')]);
    state.settings = cfg.settings || state.settings;
    renderKeys(data.keys || []);
  } catch (err) {
    if (!/Authentication/.test(err.message)) {
      $('#view-keys').replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  }
}

function copyButton(text, label = 'Copy') {
  return el('button', {
    class: 'ghost',
    type: 'button',
    text: label,
    onclick: async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select manually';
      }
      setTimeout(() => { button.textContent = label; }, 1600);
    },
  });
}

function connectCard() {
  const base = `${location.origin}/v1`;
  const model = (state.settings && state.settings.model_served_id) || 'qwen3.8-27b-uncensored-q6_k';
  const secret = state.lastKey && state.lastKey.key;
  const shown = secret || 'vx-… (create a key above, it is shown once)';
  const env = [
    `LLM_MODEL=openai/${model}`,
    `LLM_BASE_URL=${base}`,
    `LLM_API_KEY=${secret || 'vx-YOUR_KEY'}`,
  ].join('\n');
  const toml = [
    '[llm]',
    `model = "openai/${model}"`,
    `base_url = "${base}"`,
    `api_key = "${secret || 'vx-YOUR_KEY'}"`,
  ].join('\n');
  const sdk = [
    'from openhands.sdk import LLM',
    'llm = LLM(',
    `    model="openai/${model}",`,
    `    base_url="${base}",`,
    `    api_key="${secret || 'vx-YOUR_KEY'}",`,
    ')',
  ].join('\n');

  return card('Connect OpenHands',
    secret
      ? el('p', { class: 'hint', text: `Key “${state.lastKey.name}” created. This is the only time it is displayed — copy it now.` })
      : el('p', { class: 'hint', text: 'Create a key to fill in the snippets below.' }),
    el('dl', { class: 'kv' },
      el('dt', { text: 'Base URL' }), el('dd', {}, el('span', { class: 'mono', text: base }), copyButton(base)),
      el('dt', { text: 'Model' }), el('dd', {}, el('span', { class: 'mono', text: model }), copyButton(model)),
      el('dt', { text: 'API key' }), el('dd', {},
        el('span', { class: 'mono', text: shown }),
        secret ? copyButton(secret) : null)),
    el('p', { class: 'hint', text: 'Environment (.env / shell)' }),
    el('pre', { class: 'snippet', text: env }),
    el('div', { class: 'row' }, copyButton(env, 'Copy .env')),
    el('p', { class: 'hint', text: 'config.toml' }),
    el('pre', { class: 'snippet', text: toml }),
    el('div', { class: 'row' }, copyButton(toml, 'Copy config.toml')),
    el('p', { class: 'hint', text: 'Python SDK' }),
    el('pre', { class: 'snippet', text: sdk }),
    el('div', { class: 'row' }, copyButton(sdk, 'Copy snippet')),
    el('p', { class: 'hint', text: 'The GPU starts by itself on the first request when auto-start is enabled; that first call waits for the model to load.' }));
}

function renderKeys(keys) {
  const nameInput = el('input', { id: 'key-name', placeholder: 'Key name (e.g. openhands)', maxlength: '60' });
  const form = el('form', {
    class: 'row',
    onsubmit: async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      try {
        const created = await api('/api/keys', { method: 'POST', body: { name } });
        nameInput.value = '';
        state.lastKey = created;
        await loadKeys();
        $('#connect-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        alert(err.message);
      }
    },
  }, nameInput, el('button', { class: 'primary', type: 'submit', text: 'Create key' }));
  const rows = keys.map((key) => el('tr', {},
    el('td', { text: key.name }),
    el('td', { class: 'mono', text: `${key.key_prefix}…` }),
    el('td', { class: 'mono', text: fmt.when(key.created_at) }),
    el('td', { class: 'mono', text: key.last_used_at ? fmt.when(key.last_used_at) : 'never' }),
    el('td', { class: 'mono', text: String(key.requests || 0) }),
    el('td', {}, key.revoked_at
      ? el('span', { class: 'muted', text: 'revoked' })
      : el('button', {
          class: 'danger',
          text: 'Revoke',
          onclick: async () => {
            if (!confirm(`Revoke “${key.name}”? Clients using it will start failing.`)) return;
            try { await api('/api/keys/revoke', { method: 'POST', body: { id: key.id } }); await loadKeys(); }
            catch (err) { alert(err.message); }
          },
        }))));

  const table = card('Issued keys',
    el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: 'Name' }), el('th', { text: 'Prefix' }), el('th', { text: 'Created' }),
          el('th', { text: 'Last used' }), el('th', { text: 'Requests' }), el('th', { text: '' }))),
        el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: '6', class: 'muted', text: 'No keys yet.' }))))));

  $('#view-keys').replaceChildren(
    el('div', { class: 'spread' }, el('h2', { text: 'API keys' }), el('span', { class: 'muted', text: 'OpenAI-compatible access' })),
    Object.assign(connectCard(), { id: 'connect-panel' }),
    card('Create a key', form, el('p', { class: 'hint', text: 'Keys are stored hashed; the plaintext is returned once.' })),
    table);
}

async function loadLogs() {
  try {
    const [events, requests, sessions] = await Promise.all([
      api('/api/events'), api('/api/requests'), api('/api/sessions'),
    ]);
    renderLogs(events.events || [], requests.requests || [], sessions.sessions || []);
  } catch (err) {
    if (!/Authentication/.test(err.message)) {
      $('#view-logs').replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  }
}

function tableCard(title, headers, rows, empty) {
  return card(title,
    el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h })))),
        el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: String(headers.length), class: 'muted', text: empty }))))));
}

function renderLogs(events, requests, sessions) {
  const eventRows = events.map((row) => el('tr', {},
    el('td', { class: 'mono', text: fmt.when(row.ts) }),
    el('td', { text: row.kind }),
    el('td', { text: row.message })));

  const requestRows = requests.map((row) => el('tr', {},
    el('td', { class: 'mono', text: fmt.when(row.ts) }),
    el('td', { text: row.status || '—' }),
    el('td', { class: 'mono', text: `${row.prompt_tokens || 0} / ${row.completion_tokens || 0}` }),
    el('td', { class: 'mono', text: row.latency_ms ? `${(row.latency_ms / 1000).toFixed(1)}s` : '—' })));

  const sessionRows = sessions.map((row) => el('tr', {},
    el('td', { class: 'mono', text: fmt.when(row.started_at) }),
    el('td', { class: 'mono', text: row.kernel_version || '—' }),
    el('td', { text: row.status }),
    el('td', { class: 'mono', text: row.ended_at ? fmt.when(row.ended_at) : 'live' }),
    el('td', { text: row.end_reason || '—' })));
  $('#view-logs').replaceChildren(
    el('div', { class: 'spread' }, el('h2', { text: 'Logs' }), el('span', { class: 'muted', text: 'auto-refresh 10s' })),
    tableCard('Events', ['When', 'Kind', 'Message'], eventRows, 'No events recorded yet.'),
    tableCard('Requests', ['When', 'Status', 'Prompt / completion tokens', 'Latency'], requestRows, 'No API requests yet.'),
    tableCard('GPU sessions', ['Started', 'Kernel', 'Status', 'Ended', 'Reason'], sessionRows, 'No GPU sessions yet.'));
}

const FIELDS = [
  ['kaggle_username', 'Kaggle username', 'text'],
  ['kaggle_key', 'Kaggle API key', 'password'],
  ['kaggle_dataset', 'Model dataset (owner/slug)', 'text'],
  ['kernel_slug', 'Runtime kernel (owner/slug)', 'text'],
  ['model_served_id', 'Served model id', 'text'],
  ['model_file', 'Model file name', 'text'],
  ['model_bytes', 'Model size (bytes)', 'number'],
  ['model_sha256', 'Model SHA-256 (blank skips hashing)', 'text'],
  ['ctx_size', 'Context size', 'number'],
  ['parallel_slots', 'Parallel slots', 'number'],
  ['idle_timeout_minutes', 'Idle shutdown (minutes)', 'number'],
  ['public_base_url', 'Public base URL', 'text'],
];

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    renderSettings(data.settings || {});
  } catch (err) {
    if (!/Authentication/.test(err.message)) {
      $('#view-settings').replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  }
}

function renderSettings(settings) {
  const status = el('p', { class: 'muted' });
  const inputs = {};
  const fields = FIELDS.map(([key, label, type]) => {
    const spec = settings[key];
    const isSecret = spec && typeof spec === 'object';
    const value = isSecret ? '' : (spec ?? '');
    const input = el('input', {
      type,
      value,
      placeholder: isSecret ? (spec.set ? `stored · ${spec.source}` : 'not set') : '',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    inputs[key] = { input, isSecret };
    return el('label', {}, label, input,
      isSecret ? el('span', { class: 'hint', text: spec.set ? `Encrypted in D1 (${spec.source}). Leave blank to keep it.` : 'Not configured yet.' }) : null);
  });
  const form = el('form', {
    class: 'settings',
    onsubmit: async (event) => {
      event.preventDefault();
      const payload = {};
      for (const [key, { input, isSecret }] of Object.entries(inputs)) {
        const raw = input.value.trim();
        if (isSecret && !raw) continue;
        if (!isSecret && raw === '') continue;
        payload[key] = input.type === 'number' ? Number(raw) : raw;
      }
      if (!Object.keys(payload).length) { status.textContent = 'Nothing changed.'; return; }
      status.textContent = 'Saving…';
      try {
        const res = await api('/api/settings', { method: 'PUT', body: { settings: payload } });
        status.textContent = `Saved ${res.applied.length} setting(s). Restart the GPU to apply runtime changes.`;
        await loadSettings();
      } catch (err) {
        status.textContent = '';
        alert(err.message);
      }
    },
  }, ...fields, el('div', { class: 'row' }, el('button', { class: 'primary', type: 'submit', text: 'Save settings' }), status));
  $('#view-settings').replaceChildren(
    el('div', { class: 'spread' }, el('h2', { text: 'Settings' }), el('span', { class: 'muted', text: 'D1 overrides environment' })),
    card('Platform configuration', form,
      el('p', { class: 'hint', text: 'Values stored here override Worker environment variables. Secrets are sealed with AES-GCM using SECRET_KEY.' })),
    card('Platform secrets',
      el('p', { class: 'muted', text: 'INTERNAL_RUNTIME_KEY, SECRET_KEY and OPERATOR_KEY are Worker secrets set with wrangler and never exposed to the browser.' })));
}

async function boot() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.authenticated) showApp(data.operator);
    else showLogin();
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  const errorBox = $('#login-error');
  errorBox.textContent = '';
  button.disabled = true;
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#login-user').value.trim(), password: $('#login-pass').value },
    });
    $('#login-pass').value = '';
    showApp(data.operator);
  } catch (err) {
    errorBox.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#signout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  showLogin();
});

for (const button of document.querySelectorAll('.nav')) {
  button.addEventListener('click', () => navigate(button.dataset.view));
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && $('#app').hidden === false) navigate(state.view);
});

boot();
