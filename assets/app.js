/**
 * VEXA dashboard logic.
 *  - task submission → in-browser agent driving the live cloud phone
 *  - automations: fixed intervals + AI-decided scheduling
 *  - model/provider + key management (keys never leave this browser)
 */
import { PhoneLink, STATES, backendUrl } from './phone-core.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ------------------------------------------------------------------ storage */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`vexa.${key}`); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, val) { try { localStorage.setItem(`vexa.${key}`, JSON.stringify(val)); } catch {} },
};

const state = {
  tasks: store.get('tasks', []),
  automations: store.get('automations', []),
  log: store.get('log', []),
  keys: store.get('keys', {}),
  activeModel: store.get('activeModel', null),
  editing: null,
  running: false,
};

const PROVIDERS = [
  {
    id: 'xai', name: 'xAI · Grok', endpoint: 'https://api.x.ai/v1/chat/completions',
    models: ['grok-4', 'grok-3', 'grok-3-mini', 'grok-2-1212'], keyHint: 'xai-…',
  },
  {
    id: 'nvidia', name: 'NVIDIA · Nemotron', endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    models: ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'nvidia/nemotron-4-340b-instruct'],
    keyHint: 'nvapi-…',
  },
  {
    id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'], keyHint: 'sk-…',
  },
  {
    id: 'custom', name: 'Custom (OpenAI-compatible)', endpoint: '', models: ['custom-model'], keyHint: 'your key',
  },
];

/* --------------------------------------------------------------------- log */
function pushLog(kind, message) {
  const entry = { at: Date.now(), kind, message };
  state.log.push(entry);
  if (state.log.length > 400) state.log.shift();
  store.set('log', state.log);
  renderLog();
}

function renderLog() {
  for (const sel of ['#dashLog', '#fullLog']) {
    const box = $(sel);
    if (!box) continue;
    if (!state.log.length) { box.innerHTML = '<div class="log-empty">No activity yet. Submit a task to begin.</div>'; continue; }
    box.innerHTML = state.log.slice(-120).reverse().map((e) => `
      <div class="log-row ${e.kind}">
        <span class="t">${new Date(e.at).toLocaleTimeString()}</span>
        <span class="m">${escapeHtml(e.message)}</span>
      </div>`).join('');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, tone = '') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2600);
  setTimeout(() => el.remove(), 3100);
}

/* ------------------------------------------------------------------ routing */
const ROUTES = ['dashboard', 'automations', 'models', 'activity'];
function route() {
  let r = (location.hash || '#/dashboard').replace('#/', '');
  if (!ROUTES.includes(r)) r = 'dashboard';
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== r; });
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === r));
  $('#crumb').textContent = { dashboard: 'Dashboard', automations: 'Automations', models: 'AI Models', activity: 'Activity' }[r];
  $('#sidebar').classList.remove('open');
}
addEventListener('hashchange', route);

/* ------------------------------------------------------------- phone link */
const phone = new PhoneLink({ canvas: $('#miniCanvas') });
phone.addEventListener('state', (e) => paintPhoneState(e.detail));
phone.addEventListener('session', (e) => {
  const id = e.detail.sessionId;
  $('#miniSession').textContent = id || 'no session';
  $('#sidePhoneSession').textContent = id ? id.split('_').slice(-1)[0] : '—';
  $('#sidePhoneState').textContent = id ? 'Phone connected' : 'Phone offline';
  $('#sidePhoneDot').className = `dot ${id ? 'ok live' : 'bad'}`;
});
phone.addEventListener('tick', (e) => { $('#miniFps').textContent = `${e.detail.fps} fps`; });
phone.addEventListener('frame', () => { $('#miniOverlay').hidden = true; });

function paintPhoneState(s) {
  const meta = STATES[s] || STATES.connecting;
  const overlay = $('#miniPhone .mini-overlay');
  $('#sidePhoneState').textContent = meta.label.replace('…', '');
  $('#sidePhoneDot').className = `dot ${meta.tone}${s === 'live' ? ' live' : ''}`;
  // Never show a stale picture while the stream is not live: an overlay says it plainly.
  if (overlay) {
    if (s === 'live') overlay.hidden = true;
    else { overlay.hidden = false; overlay.textContent = meta.label; }
  }
}

/* ---------------------------------------------------------------- the agent */
/**
 * VEXA agent: turns a plain-language task into real actions on the cloud phone.
 * Every action is a real input event sent to the device — no simulated UI.
 */
const AGENT = {
  async run(prompt, { target = 'phone', onStep = () => {} } = {}) {
    const steps = plan(prompt);
    if (!steps.length) throw new Error('I could not turn that into actions. Try: "open Telegram", "scroll down", "type hello".');
    pushLog('info', `Task accepted: “${prompt}” (${steps.length} step${steps.length > 1 ? 's' : ''}, target: ${target})`);
    for (const step of steps) {
      onStep(step);
      await this.exec(step);
      pushLog('info', `  ↳ ${step.describe}`);
    }
    return steps;
  },

  async exec(step) {
    switch (step.type) {
      case 'home': phone.sendInput({ kind: 'keyevent', keycode: 3 }); await wait(900); break;
      case 'back': phone.sendInput({ kind: 'keyevent', keycode: 4 }); await wait(700); break;
      case 'recents': phone.sendInput({ kind: 'keyevent', keycode: 187 }); await wait(900); break;
      case 'wait': await wait(step.ms); break;
      case 'type':
        phone.sendInput({ kind: 'text', text: step.text }); await wait(700); break;
      case 'tap':
        phone.sendInput({ kind: 'pointer', action: 'down', pointerId: 0, x: step.x, y: step.y, landscape: false });
        await wait(60);
        phone.sendInput({ kind: 'pointer', action: 'up', pointerId: 0, x: step.x, y: step.y, landscape: false });
        await wait(900); break;
      case 'swipe':
        phone.sendInput({ kind: 'pointer', action: 'down', pointerId: 0, x: step.x1, y: step.y1, landscape: false });
        for (let t = 1; t <= 6; t++) {
          phone.sendInput({ kind: 'pointer', action: 'move', pointerId: 0,
            x: step.x1 + (step.x2 - step.x1) * t / 6, y: step.y1 + (step.y2 - step.y1) * t / 6, landscape: false });
          await wait(28);
        }
        phone.sendInput({ kind: 'pointer', action: 'up', pointerId: 0, x: step.x2, y: step.y2, landscape: false });
        await wait(step.settle ?? 1100); break;
      case 'openApp':
        // Launcher search is the most reliable touch-only way to launch an app:
        // HOME → open the app drawer → type the name → tap the first result.
        await this.exec({ type: 'home' });
        await this.exec({ type: 'swipe', x1: 0.5, y1: 0.94, x2: 0.5, y2: 0.34, settle: 1400 });
        await this.exec({ type: 'tap', x: 0.5, y: 0.055 });          // search field
        await wait(500);
        await this.exec({ type: 'type', text: step.app });
        await wait(1600);
        await this.exec({ type: 'tap', x: 0.5, y: 0.2 });            // first result row
        await wait(2600);
        break;
      default: break;
    }
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Very small intent parser — deterministic and inspectable. */
function plan(prompt) {
  const p = prompt.toLowerCase().trim();
  const steps = [];

  const openMatch = p.match(/(?:open|launch|start|go to)\s+(?:the\s+)?([a-z0-9 .+'-]+?)(?:\s+(?:app|application|and|then|,|\.|$))/);
  if (openMatch) {
    const app = openMatch[1].replace(/\s+app$/, '').trim();
    steps.push({ type: 'openApp', app, describe: `Open ${app} from the launcher` });
  }
  if (/\b(go\s+)?home\b/.test(p)) steps.push({ type: 'home', describe: 'Press Home' });
  if (/\b(go\s+)?back\b/.test(p)) steps.push({ type: 'back', describe: 'Press Back' });
  if (/\brecents?\b/.test(p)) steps.push({ type: 'recents', describe: 'Open Recents' });
  if (/\bscroll\s+down\b/.test(p)) steps.push({ type: 'swipe', x1: 0.5, y1: 0.78, x2: 0.5, y2: 0.3, describe: 'Scroll down' });
  if (/\bscroll\s+up\b/.test(p)) steps.push({ type: 'swipe', x1: 0.5, y1: 0.3, x2: 0.5, y2: 0.78, describe: 'Scroll up' });
  const typeMatch = prompt.match(/type\s+["“']?([^"”']+)["”']?\s*$/i);
  if (typeMatch && !openMatch) steps.push({ type: 'type', text: typeMatch[1].trim(), describe: `Type “${typeMatch[1].trim()}”` });
  const tapMatch = p.match(/tap\s+(\d{1,3})%?\s*[, ]\s*(\d{1,3})%?/);
  if (tapMatch) steps.push({ type: 'tap', x: +tapMatch[1] / 100, y: +tapMatch[2] / 100, describe: `Tap ${tapMatch[1]}%, ${tapMatch[2]}%` });

  if (!steps.length && /\bwait\b/.test(p)) steps.push({ type: 'wait', ms: 2000, describe: 'Wait' });
  return steps;
}

/* ------------------------------------------------------------------- tasks */
async function submitTask(prompt, target) {
  if (state.running) { toast('A task is already running', 'bad'); return; }
  if (!prompt.trim()) return;
  if (phone.state !== 'live') { toast('Phone is not live yet — waiting for the stream', 'bad'); }

  state.running = true;
  $('#runTaskBtn').disabled = true;
  $('#agentPillText').textContent = 'Agent working…';
  $('#agentPill .dot').className = 'dot warn live';

  const task = { id: crypto.randomUUID(), prompt, target, startedAt: Date.now(), status: 'running', steps: [] };
  state.tasks.unshift(task);
  store.set('tasks', state.tasks);
  renderStats();

  try {
    if (target === 'computer') {
      // VEXA's connected computer IS the cloud phone. Anything that must happen on a
      // desktop needs the optional desktop bridge, which is not connected here.
      throw new Error('No desktop bridge connected. In VEXA the agent executes on the cloud phone — choose “On the phone”.');
    }
    await AGENT.run(prompt, { target, onStep: (s) => { task.steps.push(s.describe); store.set('tasks', state.tasks); } });
    task.status = 'done';
    task.finishedAt = Date.now();
    pushLog('ok', `Task complete: “${prompt}”`);
    toast('Task complete', 'ok');
  } catch (err) {
    task.status = 'failed';
    task.error = err.message;
    task.finishedAt = Date.now();
    pushLog('bad', `Task failed: ${err.message}`);
    toast(err.message, 'bad');
  } finally {
    state.running = false;
    $('#runTaskBtn').disabled = false;
    $('#agentPillText').textContent = 'Agent idle';
    $('#agentPill .dot').className = 'dot ok';
    store.set('tasks', state.tasks);
    renderStats();
  }
}

function renderStats() {
  $('#statTasks').textContent = state.tasks.length;
  $('#statDone').textContent = state.tasks.filter((t) => t.status === 'done').length;
  $('#statFailed').textContent = state.tasks.filter((t) => t.status === 'failed').length;
}

/* -------------------------------------------------------------- automations */
function intervalMinutes(auto) {
  if (auto.mode === 'custom') return Math.max(1, Number(auto.customValue) * Number(auto.customUnit));
  return Math.max(1, Number(auto.intervalMin));
}

function renderAutomations() {
  const body = $('#autoBody');
  const list = state.automations;
  $('#autoCountTag').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  $('#navAutoCount').textContent = list.length;
  $('#autoEmpty').hidden = list.length > 0;
  body.innerHTML = list.map((a) => `
    <tr>
      <td class="t-task"><strong title="${escapeHtml(a.prompt)}">${escapeHtml(a.prompt)}</strong>
        <small>${a.lastRun ? 'last run ' + new Date(a.lastRun).toLocaleTimeString() : 'never run'}</small></td>
      <td>${a.aiSched ? 'AI decides' : `every ${intervalMinutes(a)} min`}</td>
      <td>${a.aiSched ? '<span class="state active">AI-scheduled</span>' : '<span class="state">Fixed</span>'}</td>
      <td>${a.enabled && a.nextRun ? new Date(a.nextRun).toLocaleString() : '—'}</td>
      <td><span class="state ${a.enabled ? 'active' : 'paused'}">${a.enabled ? 'Active' : 'Paused'}</span></td>
      <td class="row-actions">
        <button class="btn btn-ghost btn-sm" data-act="toggle" data-id="${a.id}">${a.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn btn-ghost btn-sm" data-act="run" data-id="${a.id}">Run now</button>
        <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${a.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-act="del" data-id="${a.id}">Delete</button>
      </td>
    </tr>`).join('');
}

$('#autoBody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const auto = state.automations.find((a) => a.id === btn.dataset.id);
  if (!auto) return;
  if (btn.dataset.act === 'toggle') {
    auto.enabled = !auto.enabled;
    auto.nextRun = auto.enabled ? nextRunFor(auto) : null;
    persistAutomations();
  } else if (btn.dataset.act === 'del') {
    state.automations = state.automations.filter((a) => a.id !== auto.id);
    persistAutomations();
    toast('Automation deleted');
  } else if (btn.dataset.act === 'run') {
    await runAutomation(auto, true);
  } else if (btn.dataset.act === 'edit') {
    state.editing = auto.id;
    $('#autoFormTitle').textContent = 'Edit automation';
    $('#autoPrompt').value = auto.prompt;
    if (auto.mode === 'custom') {
      $('#autoInterval').value = 'custom';
      $('#autoCustomWrap').hidden = false;
      $('#autoCustomValue').value = auto.customValue;
      $('#autoCustomUnit').value = auto.customUnit;
    } else {
      $('#autoInterval').value = String(auto.intervalMin);
      $('#autoCustomWrap').hidden = true;
    }
    $('#autoAiSched').checked = !!auto.aiSched;
    $('#autoCancel').hidden = false;
    $('#autoPrompt').focus();
  }
});

function persistAutomations() {
  store.set('automations', state.automations);
  renderAutomations();
}

function nextRunFor(auto) {
  return Date.now() + intervalMinutes(auto) * 60000;
}

$('#autoInterval')?.addEventListener('change', (e) => {
  $('#autoCustomWrap').hidden = e.target.value !== 'custom';
});

$('#autoCancel')?.addEventListener('click', () => {
  state.editing = null;
  $('#autoFormTitle').textContent = 'New automation';
  $('#autoForm').reset();
  $('#autoCustomWrap').hidden = true;
  $('#autoCancel').hidden = true;
});

$('#autoForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const prompt = $('#autoPrompt').value.trim();
  if (!prompt) { toast('Add a task prompt', 'bad'); return; }
  const sel = $('#autoInterval').value;
  const auto = state.editing
    ? state.automations.find((a) => a.id === state.editing)
    : { id: crypto.randomUUID(), enabled: true, lastRun: null };
  auto.prompt = prompt;
  auto.mode = sel === 'custom' ? 'custom' : 'fixed';
  auto.intervalMin = sel === 'custom' ? Number($('#autoCustomValue').value) : Number(sel);
  auto.customValue = Number($('#autoCustomValue').value) || 45;
  auto.customUnit = Number($('#autoCustomUnit').value) || 1;
  auto.aiSched = $('#autoAiSched').checked;
  auto.nextRun = nextRunFor(auto);
  if (!state.editing) state.automations.push(auto);
  state.editing = null;
  persistAutomations();
  $('#autoForm').reset();
  $('#autoCancel').hidden = true;
  $('#autoFormTitle').textContent = 'New automation';
  toast('Automation saved', 'ok');
  pushLog('ok', `Automation saved: “${prompt}” (${auto.aiSched ? 'AI-scheduled' : 'every ' + intervalMinutes(auto) + ' min'})`);
});

async function runAutomation(auto, manual = false) {
  if (state.running) return;
  pushLog('info', `Automation firing: “${auto.prompt}”${manual ? ' (manual)' : ''}`);
  await submitTask(auto.prompt, 'phone');
  auto.lastRun = Date.now();
  const decision = await decideNextRun(auto);
  auto.nextRun = Date.now() + decision.minutes * 60000;
  auto.aiReason = decision.reason;
  auto.aiDecided = decision.by === 'ai';
  persistAutomations();
  $('#aiNextDecision').textContent = `${decision.minutes} min`;
  $('#aiReason').textContent = decision.reason;
  $('#aiNextRun').textContent = new Date(auto.nextRun).toLocaleString();
  $('#aiSchedTag').textContent = decision.by === 'ai' ? 'model' : 'heuristic';
}

/**
 * AI-controlled scheduling: ask the model whether more work is needed and when to
 * resume. Falls back to a transparent heuristic when no model is configured.
 */
async function decideNextRun(auto) {
  const model = activeModelConfig();
  if (auto.aiSched && model) {
    try {
      const answer = await callModel(model, [
        { role: 'system', content: 'You schedule an automation. Reply with STRICT JSON only: {"more":true|false,"minutes":<integer 5-1440>,"reason":"<short>"}.' },
        { role: 'user', content: `Task: ${auto.prompt}\nLast run finished at ${new Date().toISOString()}.\nLast result: ${state.tasks[0]?.status || 'unknown'}.\nShould the agent continue, and when should it next run?` },
      ]);
      const j = JSON.parse(answer.replace(/```json|```/g, '').trim());
      return { minutes: Math.min(1440, Math.max(5, Math.round(j.minutes) || 60)), reason: j.reason || 'model decision', by: 'ai' };
    } catch (err) {
      pushLog('bad', `AI scheduling fell back to heuristic: ${err.message}`);
    }
  }
  const last = state.tasks[0];
  const failed = last && last.status === 'failed';
  const minutes = auto.aiSched ? (failed ? 15 : 60) : intervalMinutes(auto);
  return { minutes, reason: auto.aiSched ? (failed ? 'last run failed — retry sooner' : 'similar work is not due yet') : 'fixed interval', by: 'heuristic' };
}

setInterval(async () => {
  if (state.running) return;
  const due = state.automations.find((a) => a.enabled && a.nextRun && Date.now() >= a.nextRun);
  if (due) await runAutomation(due);
}, 15000);

/* ------------------------------------------------------------------- models */
function activeModelConfig() {
  if (!state.activeModel) return null;
  const { provider, model } = state.activeModel;
  const key = state.keys[provider];
  const prov = PROVIDERS.find((p) => p.id === provider);
  if (!key || !prov) return null;
  return { provider, model, key, endpoint: prov.endpoint };
}

async function callModel(cfg, messages) {
  if (!cfg.endpoint) throw new Error('Custom provider has no endpoint configured');
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, max_tokens: 300 }),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function renderProviders() {
  const wrap = $('#providers');
  wrap.innerHTML = PROVIDERS.map((p) => {
    const hasKey = Boolean(state.keys[p.id]);
    const isActive = state.activeModel?.provider === p.id;
    const modelList = p.models.map((m) => `<option value="${m}" ${state.activeModel?.provider === p.id && state.activeModel.model === m ? 'selected' : ''}>${m}</option>`).join('');
    return `
      <div class="provider ${isActive ? 'active' : ''}" data-provider="${p.id}">
        <div class="provider-head">
          <strong>${p.name}</strong>
          <span class="state ${hasKey ? 'active' : ''}">${hasKey ? 'key saved' : 'no key'}</span>
        </div>
        <input class="input" type="password" placeholder="${p.keyHint}" data-key="${p.id}"
               value="${hasKey ? '••••••••••••' : ''}" autocomplete="off" />
        ${p.id === 'custom' ? `<input class="input" placeholder="https://your-endpoint/v1/chat/completions" data-endpoint="${p.id}" value="${escapeHtml(p.endpoint || '')}" />` : ''}
        <div class="provider-foot">
          <select class="select" data-model="${p.id}">${modelList}</select>
          <button class="btn btn-sm" data-save="${p.id}">Save key</button>
          <button class="btn btn-primary btn-sm" data-use="${p.id}">Use model</button>
        </div>
      </div>`;
  }).join('');

  const active = state.activeModel;
  $('#amName').textContent = active ? `${PROVIDERS.find((p) => p.id === active.provider)?.name} · ${active.model}` : 'None selected';
  $('#amMeta').textContent = active ? 'Used for AI-controlled scheduling and agent planning.' : 'Add a key for a provider, then select a model.';
  $('#modelPillText').textContent = active ? active.model.split('/').pop() : 'No model';
  $('#modelPill .dot').className = `dot ${active && state.keys[active.provider] ? 'ok' : ''}`;
}

$('#providers')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-save],button[data-use]');
  if (!btn) return;
  const id = btn.dataset.save || btn.dataset.use;
  const provider = PROVIDERS.find((p) => p.id === id);
  if (btn.dataset.save) {
    const input = $(`input[data-key="${id}"]`);
    const value = input.value.trim();
    if (value && !value.startsWith('••')) {
      state.keys[id] = value;
      store.set('keys', state.keys);
      toast(`${provider.name} key saved in this browser`, 'ok');
      pushLog('ok', `${provider.name} API key saved locally`);
    }
    if (id === 'custom') {
      const ep = $(`input[data-endpoint="${id}"]`).value.trim();
      provider.endpoint = ep;
      store.set('customEndpoint', ep);
    }
    renderProviders();
  }
  if (btn.dataset.use) {
    if (!state.keys[id]) { toast('Save a key for this provider first', 'bad'); return; }
    const model = $(`select[data-model="${id}"]`).value;
    state.activeModel = { provider: id, model };
    store.set('activeModel', state.activeModel);
    renderProviders();
    toast(`Active model: ${model}`, 'ok');
    pushLog('ok', `Active model set to ${provider.name} · ${model}`);
  }
});

$('#wipeKeys')?.addEventListener('click', () => {
  state.keys = {};
  state.activeModel = null;
  store.set('keys', {});
  store.set('activeModel', null);
  renderProviders();
  toast('All keys removed');
});

/* -------------------------------------------------------------------- wires */
$('#taskForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  submitTask($('#taskInput').value, $('#taskTarget').value);
  $('#taskInput').value = '';
});
$('#taskInput')?.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitTask($('#taskInput').value, $('#taskTarget').value); }
});
$('#taskSuggestions')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) $('#taskInput').value = chip.dataset.task;
});
$('#clearLog')?.addEventListener('click', () => { state.log = []; store.set('log', []); renderLog(); });
$('#clearLog2')?.addEventListener('click', () => { state.log = []; store.set('log', []); renderLog(); });
$('#menuBtn')?.addEventListener('click', () => $('#app .sidebar').classList.toggle('open'));

/* --------------------------------------------------------------------- boot */
(function boot() {
  const savedEndpoint = store.get('customEndpoint', '');
  if (savedEndpoint) PROVIDERS.find((p) => p.id === 'custom').endpoint = savedEndpoint;
  route();
  renderLog();
  renderStats();
  renderAutomations();
  renderProviders();
  phone.connect();
  pushLog('info', `Connecting to phone backend at ${backendUrl()}`);
  // Keep the sidebar honest even if the socket dies quietly.
  setInterval(() => { if (phone.state !== 'live') paintPhoneState(phone.state); }, 3000);
})();
