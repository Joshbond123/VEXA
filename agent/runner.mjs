#!/usr/bin/env node
/**
 * VEXA Autonomous AI Agent Runner — Optimized for speed & reliability
 *
 * Runs in GitHub Actions (scheduled / workflow_dispatch) or locally.
 * Reads automations from data/automations.json, operates the live Android
 * emulator via the VEXA Gateway, verifies every action against the resulting
 * screen, and writes execution reports + chat feedback back to the repository.
 *
 * Bug fixes in this version:
 *   • Screen change detection uses full-base64 checksum (not PNG header bytes)
 *   • Launch actions skip screen verification — just wait and proceed
 *   • Stuck hints suggest launch(package) instead of tap(coords) when tapping fails
 *   • Home key available as reset when stuck
 *   • Loop detection + early exit prevents endless repetition
 *   • Mobilerun bridge fast-fail, reduced delays, NVIDIA 30s timeout
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = process.cwd();
const DATA_DIR = path.join(REPO_ROOT, 'data');
const AUTOMATIONS_FILE = path.join(DATA_DIR, 'automations.json');
const EMULATOR_FILE = path.join(DATA_DIR, 'emulator.json');
const EXECUTIONS_DIR = path.join(DATA_DIR, 'executions');
const CHATS_DIR = path.join(DATA_DIR, 'chats');

fs.mkdirSync(EXECUTIONS_DIR, { recursive: true });
fs.mkdirSync(CHATS_DIR, { recursive: true });

/* ------------------------------------------------------------------ config */
const NVIDIA_API_KEY = (process.env.NVIDIA_API_KEY || '').trim();
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const NVIDIA_TIMEOUT_MS = Number(process.env.NVIDIA_TIMEOUT_MS || '30000');
const XAI_API_KEY = (process.env.XAI_API_KEY || '').trim();
const XAI_MODEL = process.env.XAI_MODEL || 'grok-2-vision-1212';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_ENDPOINT = (process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1/chat/completions').trim();
const TARGET_AUTOMATION_ID = (process.env.TARGET_AUTOMATION_ID || '').trim();
const EMULATOR_ACCESS_TOKEN = (process.env.EMULATOR_ACCESS_TOKEN || '').trim();
const MOBILERUN_BRIDGE = (process.env.MOBILERUN_BRIDGE || 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');
const MAX_STEPS = Number(process.env.MAX_STEPS || '60');
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || '400');
const SCREEN_CHANGE_RETRIES = Number(process.env.SCREEN_CHANGE_RETRIES || '3');
const SCREEN_CHANGE_BACKOFF_MS = Number(process.env.SCREEN_CHANGE_BACKOFF_MS || '800');
const LAUNCH_EXTRA_DELAY_MS = Number(process.env.LAUNCH_EXTRA_DELAY_MS || '2000');
const LOOP_DETECT_THRESHOLD = Number(process.env.LOOP_DETECT_THRESHOLD || '4');
const NO_PROGRESS_STEPS = Number(process.env.NO_PROGRESS_STEPS || '8');
const PERSIST_STATE_FILE = path.join(DATA_DIR, 'agent-state.json');

const PROVIDERS = [
  {
    id: 'nvidia', key: NVIDIA_API_KEY, model: NVIDIA_MODEL,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    label: 'NVIDIA NIM', timeoutMs: NVIDIA_TIMEOUT_MS,
  },
  {
    id: 'grok', key: XAI_API_KEY, model: XAI_MODEL,
    endpoint: 'https://api.x.ai/v1/chat/completions',
    label: 'xAI Grok', timeoutMs: 30000,
  },
  {
    id: 'openai', key: OPENAI_API_KEY, model: OPENAI_MODEL,
    endpoint: OPENAI_ENDPOINT,
    label: 'OpenAI-compatible', timeoutMs: 30000,
  },
];

/* ------------------------------------------------------------------ helpers */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/* ------------------------------------------------------------------ multi-run persistence */
function saveAgentState(autoId, state) {
  const all = readJson(PERSIST_STATE_FILE, {});
  all[autoId] = state;
  writeJson(PERSIST_STATE_FILE, all);
}
function loadAgentState(autoId) {
  const all = readJson(PERSIST_STATE_FILE, {});
  return all[autoId] || null;
}
function clearAgentState(autoId) {
  const all = readJson(PERSIST_STATE_FILE, {});
  delete all[autoId];
  writeJson(PERSIST_STATE_FILE, all);
}
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/* ------------------------------------------------------------------ screenshot change detection (full-base64 checksum) */
function screenChecksum(base64) {
  // Simple checksum of the full base64 string — changes if ANY pixel changes
  let hash = 0;
  for (let i = 0; i < base64.length; i++) {
    hash = ((hash << 5) - hash + base64.charCodeAt(i)) | 0;
  }
  return hash;
}

function screensDiffer(before, after) {
  return before !== after;
}

/* ------------------------------------------------------------------ recovery helpers */
/**
 * Map a task description to the human name of the app the task needs, for
 * stuck-recovery launches. A name (not a package) is returned so the device
 * resolves the real package; hardcoding packages here launched nothing.
 */
function recoveryAppFor(instructions) {
  const t = String(instructions || '').toLowerCase();
  if (t.includes('play store')) return 'Play Store';
  if (t.includes('calculator')) return 'Calculator';
  if (t.includes('keep')) return 'Google Keep';
  if (t.includes('chrome') || t.includes('browser')) return 'Chrome';
  if (t.includes('camera')) return 'Camera';
  if (t.includes('setting')) return 'Settings';
  return 'Play Store';
}

/* ------------------------------------------------------------------ claim verification */
/**
 * Check a value the agent claims it produced against the live UI tree. Only
 * numeric results are checked: they are the unambiguous ones (a calculator
 * display, a count, a price), and the UI tree exposes them as element text.
 * Returns { checked:false } when there is nothing verifiable, so an ordinary
 * "done" is never blocked.
 */
function verifyClaim(uiHierarchy, summary) {
  if (!uiHierarchy) return { checked: false, reason: 'no ui tree available' };
  // Prefer the number that follows an '=' or 'equals', else the last number.
  const nums = String(summary).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  if (!nums.length) return { checked: false, reason: 'no numeric result claimed' };
  const afterEquals = String(summary).replace(/,/g, '').match(/=\s*(\d+(?:\.\d+)?)/);
  const value = afterEquals ? afterEquals[1] : nums[nums.length - 1];
  // A number shown on screen appears as element text such as text="10541".
  const onScreen = new RegExp(`(^|[^\\d])${value.replace('.', '\\.')}([^\\d]|$)`).test(uiHierarchy);
  return { checked: true, value, verified: onScreen };
}

/* ------------------------------------------------------------------ gateway / device */
async function getGatewayStatus(gatewayUrl) {
  if (!gatewayUrl) return { online: false, reason: 'No gatewayUrl configured in data/emulator.json' };
  try {
    const res = await fetchWithTimeout(`${gatewayUrl.replace(/\/+$/, '')}/api/public/health`, { timeoutMs: 8000 });
    if (!res.ok) return { online: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { online: true, data };
  } catch (err) { return { online: false, reason: err.message }; }
}

async function gatewayRpc(gatewayUrl, action, params = {}) {
  const url = `${gatewayUrl.replace(/\/+$/, '')}/api/agent/action`;
  const headers = { 'Content-Type': 'application/json' };
  if (EMULATOR_ACCESS_TOKEN) headers['Authorization'] = `Bearer ${EMULATOR_ACCESS_TOKEN}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST', headers,
    body: JSON.stringify({ action, ...params }),
    timeoutMs: 20000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gateway action ${action} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function captureScreenViaGateway(gatewayUrl) {
  const url = `${gatewayUrl.replace(/\/+$/, '')}/api/public/screenshot`;
  const headers = {};
  if (EMULATOR_ACCESS_TOKEN) headers['Authorization'] = `Bearer ${EMULATOR_ACCESS_TOKEN}`;
  const res = await fetchWithTimeout(url, { headers, timeoutMs: 15000 });
  if (!res.ok) throw new Error(`Screenshot failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

/* mobilerun bridge — fast-fail if unreachable */
let mobilerunAvailable = null;
async function mobilerunRequest(endpoint, body = {}, timeoutMs = 10000) {
  if (!MOBILERUN_BRIDGE) throw new Error('No mobilerun bridge configured');
  if (mobilerunAvailable === false) throw new Error('mobilerun bridge unavailable');
  try {
    const res = await fetchWithTimeout(`${MOBILERUN_BRIDGE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    });
    mobilerunAvailable = true;
    if (!res.ok) throw new Error(`mobilerun ${endpoint} failed (${res.status})`);
    return res.json();
  } catch (err) {
    mobilerunAvailable = false;
    throw err;
  }
}
async function mobilerunGet(endpoint, timeoutMs = 10000) {
  if (!MOBILERUN_BRIDGE) throw new Error('No mobilerun bridge configured');
  if (mobilerunAvailable === false) throw new Error('mobilerun bridge unavailable');
  try {
    const res = await fetchWithTimeout(`${MOBILERUN_BRIDGE}${endpoint}`, { timeoutMs });
    mobilerunAvailable = true;
    if (!res.ok) throw new Error(`mobilerun GET ${endpoint} failed (${res.status})`);
    return res.json();
  } catch (err) {
    mobilerunAvailable = false;
    throw err;
  }
}

/* Render the bridge's parsed UI elements as compact text for the model. The
 * model needs concrete tap coordinates, so bounds are given in absolute device
 * pixels. This is far more token-efficient (and less truncated) than the raw
 * uiautomator XML dump it replaces. */
function formatUiElements(elements, packageName) {
  if (!Array.isArray(elements) || elements.length === 0) return null;
  const lines = elements
    .filter((e) => e && (e.text || e.content_description) && e.bounds)
    .slice(0, 80)
    .map((e) => {
      const b = e.bounds;
      const cx = Math.round((b.left + b.right) / 2);
      const cy = Math.round((b.top + b.bottom) / 2);
      const label = (e.text || e.content_description || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `- "${label}" tap(${cx},${cy}) bounds=[${b.left},${b.top},${b.right},${b.bottom}]${e.clickable ? ' clickable' : ''}`;
    });
  if (lines.length === 0) return null;
  return `package=${packageName || 'unknown'} (${lines.length} labeled elements)\n${lines.join('\n')}`;
}

async function captureScreen(gatewayUrl) {
  // Try the mobilerun bridge first. /device/state returns the screenshot and the
  // parsed element list from the same moment, so the coordinates the model sees
  // match the frame it is looking at.
  try {
    const data = await mobilerunGet('/device/state', 25000);
    const shot = data.screenshot || {};
    if (data.ok && shot.screenshot_base64) {
      return {
        screenshotB64: shot.screenshot_base64,
        uiHierarchy: formatUiElements(data.elements, data.package),
      };
    }
  } catch { /* fall through */ }
  try {
    const data = await mobilerunGet('/device/screenshot', 10000);
    if (data.ok && data.screenshot_base64) {
      let uiHierarchy = null;
      try {
        const ui = await mobilerunGet('/device/ui', 15000);
        uiHierarchy = formatUiElements(ui.elements, ui.package);
      } catch { /* UI tree unavailable */ }
      return { screenshotB64: data.screenshot_base64, uiHierarchy };
    }
  } catch { /* fall through to gateway */ }
  // Fall back to gateway screenshot + device-state endpoints
  const screenshotB64 = await captureScreenViaGateway(gatewayUrl);
  let uiHierarchy = null;
  try {
    const res = await fetchWithTimeout(`${gatewayUrl.replace(/\/$/, '')}/api/public/device-state`, { timeoutMs: 8000 });
    if (res.ok) {
      const state = await res.json();
      uiHierarchy = state.uiHierarchy || null;
    }
  } catch { /* UI hierarchy unavailable */ }
  return { screenshotB64, uiHierarchy };
}

async function deviceAction(gatewayUrl, action, params = {}) {
  const mr = await mapActionToMobilerun(action, params);
  if (mr) {
    try {
      const res = await mobilerunRequest(mr.endpoint, mr.body, 20000);
      if (res.ok) return { ok: true, action, source: 'mobilerun', ...res };
      throw new Error(res.error || `mobilerun ${mr.endpoint} returned not-ok`);
    } catch (err) {
      // fall through to gateway
    }
  }
  const result = await gatewayRpc(gatewayUrl, action, params);
  // The emulator polls the relay every ~2s. Without waiting for it to pick the
  // action up and report back, the very next capture reads the pre-action frame
  // and every action looks like it did nothing.
  await waitForActionCompletion(gatewayUrl);
  return result;
}

/* Wait until the emulator has executed the queued action and reported a result.
 * Resolves as soon as lastActionResult is no longer 'pending'; on timeout it
 * resolves anyway so a slow frame never blocks the whole task. */
async function waitForActionCompletion(gatewayUrl, timeoutMs = 60000) {
  if (!gatewayUrl) return false;
  const url = `${gatewayUrl.replace(/\/+$/, '')}/api/public/device-state`;
  const deadline = Date.now() + timeoutMs;
  let sawPending = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 6000 });
      if (res.ok) {
        const state = await res.json();
        const raw = state.lastActionResult;
        if (raw === 'pending') {
          sawPending = true;
        } else if (sawPending || raw) {
          // Action finished (success or failure) — the screen is now fresh.
          return true;
        }
      }
    } catch { /* transient; keep polling */ }
    await sleep(500);
  }
  return false;
}

function mapActionToMobilerun(action, params) {
  const m = {
    tap: { endpoint: '/device/tap', body: { x: params.x, y: params.y } },
    swipe: { endpoint: '/device/swipe', body: { x1: params.x, y1: params.y, x2: params.x2, y2: params.y2, duration_ms: params.duration_ms || 300 } },
    scroll: { endpoint: '/device/scroll', body: { x: params.x || 540, y: params.y || 1200, direction: params.direction || 'down' } },
    type: { endpoint: '/device/type', body: { text: params.text, clear: params.clear } },
    key: { endpoint: '/device/key', body: { keycode: params.keycode || 66 } },
    back: { endpoint: '/device/key', body: { keycode: 4 } },
    home: { endpoint: '/device/key', body: { keycode: 3 } },
    launch: { endpoint: '/device/launch_app', body: { package: params.text || params.app } },
  };
  return m[action] || null;
}

async function inspectDeviceState(gatewayUrl) {
  try {
    const state = await mobilerunGet('/device/state', 8000);
    if (state.ok) return state;
  } catch { /* fall through */ }
  return { source: 'gateway', note: 'mobilerun state unavailable' };
}

/* ------------------------------------------------------------------ Play Store "Complete account setup" gate dismissal */
async function dismissPlayStoreBlockers(gatewayUrl) {
  // Capture current screen and ask AI if a Play Store account-setup gate is visible
  const screenData = await captureScreen(gatewayUrl);
  const screenshotB64 = screenData.screenshotB64;
  const uiHierarchy = screenData.uiHierarchy;
  const decision = await askAgentBrain({
    task: "Check if this screen shows a Google Play Store 'Complete account setup' or 'Add a payment option' gate/dialog. If yes, respond with action 'tap' at the Skip button coordinates. If no gate is visible, respond with action 'done'.",
    history: [],
    stepIndex: 0,
    screenshotBase64: screenshotB64,
    uiHierarchy: uiHierarchy,
    deviceState: { source: 'gate-check' },
  });

  if (decision.action === 'tap' && decision.x && decision.y) {
    try {
      await deviceAction(gatewayUrl, 'tap', { x: decision.x, y: decision.y });
      await sleep(1500);
      return { dismissed: true, coords: { x: decision.x, y: decision.y } };
    } catch (err) {
      return { dismissed: false, error: err.message };
    }
  }
  return { dismissed: false, reason: 'No Play Store gate detected' };
}

/* ------------------------------------------------------------------ AI provider with rotation + fallback */
function stripReasoning(text) {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/\[?\s*\/?thinking\s*\]?/gi, '')
    .replace(/```json[\s\S]*?```/gi, '')
    .trim();
}

function extractJson(text) {
  const cleaned = stripReasoning(text);
  const match = cleaned.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
  if (!match) throw new Error(`Agent returned non-JSON: ${cleaned.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

async function callProvider(provider, messages, attempt = 1) {
  if (!provider.key) throw new Error(`${provider.label}: no API key configured`);
  const body = {
    model: provider.model,
    messages,
    temperature: 0.2,
    max_tokens: 512,
    stream: false,
  };
  if (provider.id === 'grok') body.stream_options = { include_usage: true };

  const res = await fetchWithTimeout(provider.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: provider.timeoutMs,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const status = res.status;
    if ((status === 429 || status >= 500) && attempt < 2) {
      await sleep(1500 * attempt);
      return callProvider(provider, messages, attempt + 1);
    }
    throw new Error(`${provider.label} API error ${status}: ${txt.slice(0, 400)}`);
  }

  const json = await res.json();
  const raw = (json.choices?.[0]?.message?.content || '');
  return stripReasoning(raw);
}

async function askAgentBrain({ task, history, stepIndex, screenshotBase64, uiHierarchy, deviceState, stuckHint }) {
  const stuckSection = stuckHint
    ? `\nWARNING: You appear stuck — the same action has been repeated ${LOOP_DETECT_THRESHOLD}+ times without screen change.\nTRY A DIFFERENT APPROACH:\n  • Use "launch" with package name (e.g. {"action":"launch","app":"com.android.vending"}) instead of tap\n  • Press "home" to reset to home screen, then try again\n  • Use "swipe" instead of "tap"\n  • Use "type" to search in the search bar\nDo NOT keep tapping the same coordinates.\n`
    : '';

  // Build UI element description for the agent. This is the parsed element list
  // from the live device (text/content-desc with absolute tap coordinates), so
  // the model can tap exact centres instead of guessing pixels from an image.
  const uiSection = uiHierarchy
    ? `\n\nCURRENT UI ELEMENTS (live accessibility tree, absolute device pixels):\n${uiHierarchy.slice(0, 6000)}\n\nEach line gives a visible label and the exact tap(x,y) centre for it. Prefer tapping these coordinates over estimating from the image. If the element you need is not listed, swipe to reveal more or use the screenshot.\n`
    : '';

  // Report the device's real resolution and let the device decide how a launch
  // is resolved: the image ships com.android.calculator2, not
  // com.google.android.calculator, and a wrong package makes the agent retry
  // forever.
  const deviceResolution = (deviceState && deviceState.resolution) || '1080x1920';
  const systemPrompt = `You are VEXA, an autonomous AI agent operating a real Android phone (${deviceResolution}).\nInspect the current screen and device state, then decide the SINGLE next action to accomplish the user's task.\nRespond ONLY with valid JSON, no markdown fences, no reasoning tags:\n{\n  "thought": "brief reasoning about what you see on screen",\n  "action": "tap|swipe|scroll|type|key|back|home|launch|wait|done|fail",\n  "x": 540, "y": 1200, "x2": 540, "y2": 400,\n  "text": "text to type or package name to launch",\n  "keycode": 66,\n  "ms": 2000,\n  "app": "App Name",\n  "summary": "final summary if done/fail",\n  "outcomeAchieved": true,\n  "nextRunMinutes": null\n}\nFor "launch", pass a human app name (e.g. "Calculator", "Settings", "Chrome") in "app"; the device resolves the correct package. Only use a package name if you already know it exists on this device.\n\nA task is complete ONLY when you have verified the result on screen. Never claim success without observing the screen.\nIf you are stuck, try a completely different approach — launch the app by name, swipe, or press home first.\nNever include <thinking> or internal reasoning in your response.${stuckSection}`;

  const userContent = [
    { type: 'text', text: `Task: ${task}\nStep: ${stepIndex + 1}\nPrevious steps:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n') || 'None'}\n\nDevice state: ${JSON.stringify(deviceState || {}).slice(0, 1000)}${uiSection}` },
  ];
  if (screenshotBase64) {
    userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}` } });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  let lastError = '';
  for (const provider of PROVIDERS) {
    if (!provider.key) continue;
    try {
      const raw = await callProvider(provider, messages);
      const decision = extractJson(raw);
      decision._provider = provider.id;
      return decision;
    } catch (err) {
      lastError = `${provider.label}: ${err.message}; `;
      continue;
    }
  }
  throw new Error(`All AI providers failed. Last error: ${lastError}`);
}

/* ------------------------------------------------------------------ run automation */
async function runAutomation(automation, emulator) {
  const startedAt = new Date().toISOString();
  const execId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const actionsPerformed = [];
  const appsInteracted = new Set();
  let observedResults = '';
  let outcomeAchieved = false;
  let failures = null;
  let status = 'running';
  let aiNextMinutes = null;
  let checkpoints = [];

  // Multi-run persistence: load any previously saved state for this automation
  const persistedState = loadAgentState(automation.id);
  const isResuming = persistedState !== null;

  const actionCounts = new Map();
  let lastScreenChecksum = null;
  let lastUiHierarchy = null;
  let stepsWithoutProgress = 0;

  // Restore action counts from persisted state if resuming
  if (persistedState?.actionCounts) {
    for (const [k, v] of Object.entries(persistedState.actionCounts)) {
      actionCounts.set(k, v);
    }
  }

  const gwCheck = await getGatewayStatus(emulator.gatewayUrl);
  if (!gwCheck.online) {
    status = 'failed';
    failures = `Android emulator gateway is offline (${gwCheck.reason}). Start the Android Emulator workflow first.`;
    observedResults = 'Could not connect to running Android emulator.';
  } else {
    try {
      // If resuming, skip HOME press to preserve current screen state
      if (!isResuming) {
        // Press HOME first to ensure we're on the home screen (resets any dialogs/locks)
        try {
          await deviceAction(emulator.gatewayUrl, 'home', {});
          await sleep(800);
        } catch (e) {
          // Non-fatal — continue even if home key fails
        }

        // Dismiss Play Store "Complete account setup" gate if visible (tap Skip)
        try {
          const gateResult = await dismissPlayStoreBlockers(emulator.gatewayUrl);
          if (gateResult.dismissed) {
            actionsPerformed.push(`GATE DISMISSED: Play Store account-setup gate skipped at (${gateResult.coords.x},${gateResult.coords.y})`);
            observedResults = `Play Store account gate dismissed — skipped 'Add a payment option' dialog.`;
          }
        } catch (e) {
          // Non-fatal — continue even if gate dismissal fails
        }
      } else {
        observedResults = `Resuming task from step ${persistedState.step + 1} (saved state restored).`;
      }

      // Determine starting step (resume from persisted state)
      const startStep = isResuming ? persistedState.step : 0;

      for (let step = startStep; step < MAX_STEPS; step++) {
        const checkpoint = { step: step + 1, at: new Date().toISOString(), resuming: isResuming && step === startStep };
        const screenData = await captureScreen(emulator.gatewayUrl);
        const screenshotB64 = screenData.screenshotB64;
        const uiHierarchy = screenData.uiHierarchy;
        const screenChecksumVal = screenChecksum(screenshotB64 || '');
        const deviceState = await inspectDeviceState(emulator.gatewayUrl);

        const uiChanged = uiHierarchy !== null && uiHierarchy !== lastUiHierarchy;
        const screenshotUninformative = !screenshotB64 || screenshotB64.length < 1000;
        const uiHierarchyUnavailable = uiHierarchy === null;
        const screenStuck = lastScreenChecksum !== null && screenChecksumVal === lastScreenChecksum && !uiChanged && !screenshotUninformative;
        if (screenStuck) {
          stepsWithoutProgress++;
        } else {
          stepsWithoutProgress = 0;
        }
        lastScreenChecksum = screenChecksumVal;
        lastUiHierarchy = uiHierarchy;

        if (stepsWithoutProgress >= NO_PROGRESS_STEPS) {
          status = 'failed';
          failures = `No screen progress for ${NO_PROGRESS_STEPS} consecutive steps — agent appears stuck.`;
          observedResults = `Agent stopped early after ${step + 1} steps with no visible progress.`;
          checkpoint.result = status;
          checkpoint.summary = failures;
          checkpoints.push(checkpoint);
          break;
        }

        let decision;
        try {
        decision = await askAgentBrain({
          task: automation.instructions,
          history: actionsPerformed,
          stepIndex: step,
          screenshotBase64: screenshotB64,
          uiHierarchy: uiHierarchy,
          deviceState,
          stuckHint: stepsWithoutProgress >= 2,
        });
        } catch (aiErr) {
          // AI failure fallback: launch Play Store directly instead of failing the whole task
          console.warn(`AI provider failed: ${aiErr.message}. Falling back to launch(com.android.vending)`);
          decision = {
            action: 'launch',
            text: 'com.android.vending',
            app: 'com.android.vending',
            thought: 'AI provider unavailable — launching Play Store directly',
            _provider: 'fallback',
          };
        }

        if (decision.app) appsInteracted.add(decision.app);

        // --- NORMALIZE MALFORMED AI ACTIONS ---
        // AI sometimes returns combined strings like "tap(151,664)" or "launch(com.android.vending)"
        // Parse them into proper action + params
        if (decision.action && typeof decision.action === 'string') {
          const actionMatch = decision.action.match(/^(\w+)\((.+)\)$/);
          if (actionMatch) {
            const parsedAction = actionMatch[1];
            const parsedArgs = actionMatch[2];
            // Only override if the current action doesn't already have proper x/y
            // Normalize malformed action strings like "launch(undefined,undefined)"
            // regardless of what's in text/app fields — they'll be overwritten
            if (!decision.x && !decision.y) {
              if (parsedAction === 'tap' || parsedAction === 'swipe') {
                const coords = parsedArgs.split(',').map(c => Number(c.trim()));
                if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
                  console.warn(`Normalizing malformed action "${decision.action}" → tap(${coords[0]},${coords[1]})`);
                  decision.action = parsedAction;
                  decision.x = coords[0];
                  decision.y = coords[1];
                }
              } else if (parsedAction === 'launch') {
                const targetPkg = parsedArgs.trim();
                // Reject coordinate-like args (e.g. "0,0", "540,1200") and "undefined" variants.
                const looksLikeCoords = /^\d+,\d+$/.test(targetPkg);
                const pkg = (looksLikeCoords || targetPkg === 'undefined' || targetPkg === 'undefined,undefined' || !targetPkg)
                  ? recoveryAppFor(automation.instructions)
                  : targetPkg;
                console.warn(`Normalizing malformed action "${decision.action}" → launch(${pkg})`);
                decision.action = parsedAction;
                decision.text = pkg;
                decision.app = pkg;
              }
            }
          }
        }

        // Ensure a launch always carries a target. Do NOT force a package: a
        // human app name ("Calculator") is resolved to the right package by the
        // device. The previous code overwrote any name without a dot with
        // com.google.android.calculator, which is not installed, so every
        // launch-by-name silently became a failed launch.
        if (decision.action === 'launch' && !decision.text && !decision.app) {
          const fallback = recoveryAppFor(automation.instructions);
          decision.text = fallback;
          decision.app = fallback;
        }
        if (decision.action === 'launch' && decision.app && !decision.text) decision.text = decision.app;
        if (decision.action === 'launch' && decision.text && !decision.app) decision.app = decision.text;

        if (decision.action === 'done') {
          // The model is told to verify on screen before claiming success, but
          // it does not always comply: it once reported "127 × 83 = 10,541"
          // after looping on the same tap. Check the claimed result against the
          // live UI tree before believing it, and fail honestly when it is not
          // there.
          const claim = verifyClaim(uiHierarchy, decision.summary || decision.thought || '');
          outcomeAchieved = Boolean(decision.outcomeAchieved === true);
          observedResults = decision.summary || decision.thought || 'Task completed.';
          aiNextMinutes = decision.nextRunMinutes ?? null;
          if (outcomeAchieved && claim.checked && !claim.verified) {
            outcomeAchieved = false;
            failures = `Agent claimed success (${claim.value}) but that value is not visible on screen — result unverified.`;
            observedResults = `${observedResults} [UNVERIFIED: ${claim.value} not found in the on-screen UI tree]`;
            status = 'failed';
          } else {
            status = outcomeAchieved ? 'completed' : 'failed';
          }
          checkpoint.result = status;
          checkpoint.summary = observedResults;
          checkpoint.claimVerification = claim;
          checkpoints.push(checkpoint);
          break;
        }
        if (decision.action === 'fail') {
          outcomeAchieved = false;
          failures = decision.summary || decision.thought || 'Agent reported task could not be completed.';
          status = 'failed';
          checkpoint.result = status;
          checkpoint.summary = failures;
          checkpoints.push(checkpoint);
          break;
        }

        const actionKey = `${decision.action}:${decision.x || 0}:${decision.y || 0}`;
        const count = (actionCounts.get(actionKey) || 0) + 1;
        actionCounts.set(actionKey, count);
        const stuckHint = count >= LOOP_DETECT_THRESHOLD;

        // STUCK RECOVERY: when loop detected on tap, override with launch(app).
        // Pass a human app name and let the device resolve the package: the old
        // hardcoded com.google.android.calculator does not exist on the API 28
        // image (it is com.android.calculator2), so recovery launched nothing.
        if (stuckHint && decision.action === 'tap') {
          const targetApp = recoveryAppFor(automation.instructions);
          actionsPerformed.push(`RECOVERY: loop detected on tap(${decision.x},${decision.y}) — overriding to launch(${targetApp})`);
          checkpoint.recoveryAction = `launch:${targetApp}`;
          decision.action = 'launch';
          decision.text = targetApp;
          decision.app = targetApp;
        }

        // STUCK RECOVERY: a launch that keeps repeating means the app either
        // did not open or the model cannot read the screen it produced. Fall
        // back to HOME so the next step re-reads a known screen instead of
        // typing a hardcoded string into an unknown field.
        if (stuckHint && decision.action === 'launch') {
          actionsPerformed.push(`RECOVERY: loop detected on launch(${decision.app}) — overriding to home`);
          checkpoint.recoveryAction = 'home';
          decision.action = 'home';
          decision.text = null;
          decision.app = null;
        }

        let actionResult;
        let screenChanged = false;
        let lastActionError = null;

        for (let retry = 0; retry <= SCREEN_CHANGE_RETRIES; retry++) {
          try {
            actionResult = await deviceAction(emulator.gatewayUrl, decision.action, {
              x: decision.x, y: decision.y, x2: decision.x2, y2: decision.y2,
              text: decision.text, keycode: decision.keycode, ms: decision.ms,
              app: decision.app, clear: decision.clear,
            });
            lastActionError = null;

            const settleMs = (decision.action === 'launch' || decision.action === 'type')
              ? STEP_DELAY_MS + LAUNCH_EXTRA_DELAY_MS
              : STEP_DELAY_MS;
            await sleep(settleMs);

            const postScreenData = await captureScreen(emulator.gatewayUrl);
            const postScreenshot = postScreenData.screenshotB64;
            const postUiHierarchy = postScreenData.uiHierarchy;
            const postState = await inspectDeviceState(emulator.gatewayUrl);

            checkpoint.postScreenshotBytes = postScreenshot.length;
            checkpoint.postDeviceState = postState;

            // Launch actions: skip screen verification — just proceed
            if (decision.action === 'launch') {
              screenChanged = true;
              break;
            }

            const uiChanged = postUiHierarchy && postUiHierarchy !== uiHierarchy;
            const screenshotUninformative = !screenshotB64 || screenshotB64.length < 1000;
            const uiHierarchyUnavailable = !postUiHierarchy;

            // When screenshots are 1x1 placeholders and UI hierarchy is unavailable,
            // we cannot verify screen changes. Proceed assuming the action executed.
            if (screenshotUninformative && uiHierarchyUnavailable) {
              screenChanged = true;
              break;
            }

            if (screensDiffer(screenshotB64, postScreenshot) || uiChanged) {
              screenChanged = true;
              break;
            }

            lastActionError = `Screen unchanged after ${decision.action}; retry ${retry + 1}/${SCREEN_CHANGE_RETRIES}`;
            checkpoint.screenUnchangedRetries = (retry + 1);
            await sleep(SCREEN_CHANGE_BACKOFF_MS * (retry + 1));

          } catch (err) {
            lastActionError = err.message;
            checkpoint.error = err.message;
            await sleep(SCREEN_CHANGE_BACKOFF_MS * (retry + 1));
          }
        }

        checkpoint.action = decision.action;
        checkpoint.thought = decision.thought;
        checkpoint.provider = decision._provider;
        checkpoint.screenChanged = screenChanged;
        checkpoint.lastActionError = lastActionError;
        checkpoint.loopDetected = stuckHint;
        checkpoints.push(checkpoint);

        const desc = `${decision.action}(${decision.text || `${decision.x},${decision.y}`})`;
        actionsPerformed.push(`${desc} — ${decision.thought}` + (screenChanged ? ' [screen changed]' : ' [screen unchanged after retries]') + (stuckHint ? ' [LOOP DETECTED]' : ''));

        // --- AGGRESSIVE STUCK RECOVERY ---
        // If screen didn't change after all retries AND the action was a tap,
        // override with launch(package) to break out of the deadlock
        if (!screenChanged && decision.action === 'tap') {
          const targetApp = recoveryAppFor(automation.instructions);
          console.warn(`STUCK RECOVERY: tap(${decision.x},${decision.y}) produced no screen change — overriding to launch(${targetApp})`);
          actionsPerformed.push(`RECOVERY: tap(${decision.x},${decision.y}) stuck — overriding to launch(${targetApp})`);
          checkpoint.recoveryAction = `launch:${targetApp}`;
          checkpoint.stuckRecovery = true;
          // Try launching the app directly
          try {
            await deviceAction(emulator.gatewayUrl, 'launch', { app: targetApp, text: targetApp });
            await sleep(LAUNCH_EXTRA_DELAY_MS);
            // Verify screen changed after launch
            const postLaunchScreenshot = await captureScreen(emulator.gatewayUrl);
            if (screensDiffer(screenshotB64, postLaunchScreenshot)) {
              screenChanged = true;
              lastActionError = null;
              observedResults = `Recovery launch(${targetApp}) succeeded — screen changed.`;
              actionsPerformed.push(`RECOVERY: launch(${targetApp}) — screen changed ✅`);
            } else {
              observedResults = `Recovery launch(${targetApp}) attempted but screen unchanged.`;
            }
          } catch (launchErr) {
            observedResults = `Recovery launch(${targetApp}) failed: ${launchErr.message}`;
          }
        }

        if (!screenChanged && decision.action !== 'launch' && !checkpoint.stuckRecovery) {
          failures = (failures ? failures + '; ' : '') + `Step ${step + 1} (${decision.action}) did not change screen after ${SCREEN_CHANGE_RETRIES + 1} attempts: ${lastActionError || 'unknown'}`;
          observedResults = `Action ${desc} did not produce a visible screen change after ${SCREEN_CHANGE_RETRIES + 1} attempts.`;
        } else if (screenChanged && !checkpoint.stuckRecovery) {
          observedResults = `Action ${desc} executed. Post-action screen captured (${checkpoint.postScreenshotBytes} bytes). Device state: ${JSON.stringify(checkpoint.postDeviceState || {}).slice(0, 300)} [screen changed — action had effect]`;
        }

        // --- PERSIST STATE AFTER EACH STEP (multi-run support) ---
        saveAgentState(automation.id, {
          step: step + 1,
          actionsPerformed,
          appsInteracted: Array.from(appsInteracted),
          observedResults,
          failures,
          actionCounts: Object.fromEntries(actionCounts),
          startedAt,
          automationId: automation.id,
          task: automation.instructions,
        });
      }
    } catch (err) {
      status = 'failed';
      failures = err.message;
    }
  }

  const finishedAt = new Date().toISOString();

  // Clear persisted state if task is complete or failed (not continuing)
  if (status !== 'continuing') {
    clearAgentState(automation.id);
  }

  let nextRunAt = null;
  if (automation.scheduleType === 'once') {
    if (outcomeAchieved) { automation.enabled = false; automation.status = 'completed'; }
    else if (status === 'continuing') { automation.status = 'continuing'; automation.enabled = true; automation.paused = false; }
    else { automation.status = status; }
  } else if (automation.enabled && !automation.paused) {
    const mins = automation.scheduleType === 'ai_decided' && aiNextMinutes
      ? Math.max(15, Number(aiNextMinutes))
      : Number(automation.intervalMinutes || 60);
    nextRunAt = new Date(Date.now() + mins * 60000).toISOString();
    automation.status = status === 'continuing' ? 'continuing' : 'waiting';
  } else {
    automation.status = automation.paused ? 'stopped' : status;
  }

  automation.nextRunAt = nextRunAt;
  automation.lastRunAt = finishedAt;
  automation.lastRunStatus = status;
  automation.runCount = (automation.runCount || 0) + 1;
  automation.updatedAt = finishedAt;

  const report = {
    id: execId,
    automationId: automation.id,
    status,
    startedAt,
    finishedAt,
    taskReceived: automation.instructions,
    actionsPerformed,
    appsInteracted: Array.from(appsInteracted),
    observedResults,
    outcomeAchieved,
    failures,
    checkpoints,
    nextExecutionScheduled: nextRunAt,
    resuming: isResuming,
  };

  const execFile = path.join(EXECUTIONS_DIR, `${automation.id}.json`);
  const execList = readJson(execFile, []);
  execList.unshift(report);
  writeJson(execFile, execList.slice(0, 50));

  const chatFile = path.join(CHATS_DIR, `${automation.id}.json`);
  const chatList = readJson(chatFile, []);
  chatList.push({
    id: `msg_${Date.now()}`,
    role: 'agent',
    executionId: execId,
    timestamp: finishedAt,
    content: [
      `**Execution Report (${status.toUpperCase()})**`,
      `• **Task:** ${report.taskReceived}`,
      `• **Provider:** ${PROVIDERS.find((p) => p.id === (report.checkpoints?.[report.checkpoints.length - 1]?.provider) || {}).id || 'unknown'}`,
      `• **Actions:** ${actionsPerformed.length ? actionsPerformed.join(' → ') : 'None'}`,
      `• **Apps:** ${report.appsInteracted.length ? report.appsInteracted.join(', ') : 'None'}`,
      `• **Observed:** ${observedResults || 'N/A'}`,
      failures ? `• **Failures:** ${failures}` : null,
      `• **Outcome Achieved:** ${outcomeAchieved}`,
      `• **Status:** ${status}`,
      `• **Next Run:** ${nextRunAt || 'None (completed/stopped)'}`,
      isResuming ? `• **Resumed from:** step ${persistedState.step}` : null,
    ].filter(Boolean).join('\n'),
  });
  writeJson(chatFile, chatList.slice(-100));


  try {
    const sessionsFile = path.join(DATA_DIR, 'sessions.json');
    const sessions = readJson(sessionsFile, []);
    sessions.unshift({
      id: execId,
      automationId: automation.id,
      status,
      startedAt,
      finishedAt,
      outcomeAchieved,
      gateway: emulator.gatewayUrl || '',
      mobilerunBridge: MOBILERUN_BRIDGE || '',
    });
    writeJson(sessionsFile, sessions.slice(0, 100));
  } catch {}

  return report;
}

async function main() {
  const automations = readJson(AUTOMATIONS_FILE, []);
  const emulator = readJson(EMULATOR_FILE, { gatewayUrl: '' });
  const now = Date.now();

  const due = automations.filter((a) => {
    if (TARGET_AUTOMATION_ID) return a.id === TARGET_AUTOMATION_ID;
    if (!a.enabled || a.paused) return false;
    if (a.status === 'continuing') return true; // resume continuing tasks immediately
    if (!a.nextRunAt) return a.status === 'queued';
    return new Date(a.nextRunAt).getTime() <= now;
  });

  console.log(`Found ${due.length} due automation(s) out of ${automations.length}.`);
  for (const auto of due) {
    console.log(`Running automation ${auto.id} (${auto.name}) via ${auto.scheduleType} schedule...`);
    await runAutomation(auto, emulator);
  }

  writeJson(AUTOMATIONS_FILE, automations);
  console.log('Done.');
}

// Exported for unit tests; importing this module must not start the agent loop.
export { mapActionToMobilerun, formatUiElements, screensDiffer, screenChecksum, verifyClaim, recoveryAppFor };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
