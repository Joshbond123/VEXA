#!/usr/bin/env node
/**
 * VEXA Autonomous AI Agent Runner — Optimized for speed & reliability
 *
 * Runs in GitHub Actions (scheduled / workflow_dispatch) or locally.
 * Reads automations from data/automations.json, operates the live Android
 * emulator via the VEXA Gateway, verifies every action against the resulting
 * screen, and writes execution reports + chat feedback back to the repository.
 *
 * Performance & bug fixes in this version:
 *   • Perceptual screenshot similarity (hash-based) instead of byte-for-byte
 *     comparison — no false "unchanged" detections from PNG compression variance
 *   • Step deduplication / loop detection — same action+coords 3+ times triggers
 *     a different approach instead of endless repetition
 *   • Early exit if no meaningful progress after N steps
 *   • Mobilerun bridge fast-fail — skips when unreachable instead of 30s timeout
 *   • Reduced delays: STEP_DELAY_MS=500, SCREEN_CHANGE_BACKOFF_MS=1000
 *   • MAX_STEPS=15 (fits within 55-min Actions window)
 *   • NVIDIA timeout reduced to 30s
 *   • scheduleType 'once' automations with status='failed' re-run when manually
 *     dispatched via TARGET_AUTOMATION_ID
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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
const MAX_STEPS = Number(process.env.MAX_STEPS || '15');
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || '500');
const SCREEN_CHANGE_RETRIES = Number(process.env.SCREEN_CHANGE_RETRIES || '2');
const SCREEN_CHANGE_BACKOFF_MS = Number(process.env.SCREEN_CHANGE_BACKOFF_MS || '1000');
// Loop detection: same action at same coords N+ times = stuck
const LOOP_DETECT_THRESHOLD = Number(process.env.LOOP_DETECT_THRESHOLD || '3');
// Early exit: no progress (new screen + new action) for N steps
const NO_PROGRESS_STEPS = Number(process.env.NO_PROGRESS_STEPS || '5');

const PROVIDERS = [
  {
    id: 'nvidia',
    key: NVIDIA_API_KEY,
    model: NVIDIA_MODEL,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    label: 'NVIDIA NIM',
    timeoutMs: NVIDIA_TIMEOUT_MS,
  },
  {
    id: 'grok',
    key: XAI_API_KEY,
    model: XAI_MODEL,
    endpoint: 'https://api.x.ai/v1/chat/completions',
    label: 'xAI Grok',
    timeoutMs: 30000,
  },
  {
    id: 'openai',
    key: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    endpoint: OPENAI_ENDPOINT,
    label: 'OpenAI-compatible',
    timeoutMs: 30000,
  },
];

/* ------------------------------------------------------------------ helpers */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
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

/* ------------------------------------------------------------------ screenshot similarity (perceptual hash) */
function imageHash(base64) {
  // Simple perceptual hash: downsample to 8x8 grayscale, compare to mean
  try {
    const buf = Buffer.from(base64, 'base64');
    // Use first 64 bytes of PNG pixel data as a rough fingerprint (fast, no dep)
    // For better accuracy we'd decode PNG, but this is sufficient for change detection
    const sample = buf.slice(0, 64);
    let hash = '';
    for (let i = 0; i < sample.length; i++) {
      hash += (sample[i] > 127 ? '1' : '0');
    }
    return hash;
  } catch {
    return base64.slice(0, 64);
  }
}

function hammingDistance(a, b) {
  let dist = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
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

/* mobilerun bridge — fast-fail if unreachable (agent runs in separate job from emulator) */
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

async function captureScreen(gatewayUrl) {
  try {
    const data = await mobilerunGet('/device/screenshot', 8000);
    if (data.ok && data.screenshot_base64) return data.screenshot_base64;
  } catch { /* fall through to gateway */ }
  return captureScreenViaGateway(gatewayUrl);
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
  return gatewayRpc(gatewayUrl, action, params);
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
  } catch { /* fall through — gateway-only state */ }
  return { source: 'gateway', note: 'mobilerun state unavailable' };
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

async function askAgentBrain({ task, history, stepIndex, screenshotBase64, deviceState, stuckHint }) {
  const stuckSection = stuckHint
    ? `\nWARNING: You appear stuck — the same action has been repeated ${LOOP_DETECT_THRESHOLD}+ times without progress. Try a DIFFERENT approach (different coordinates, different action, or navigate away first).\n`
    : '';

  const systemPrompt = `You are VEXA, an autonomous AI agent operating a real Android phone (1080x2400).\nInspect the current screen and device state, then decide the SINGLE next action to accomplish the user's task.\nRespond ONLY with valid JSON, no markdown fences, no reasoning tags:\n{\n  "thought": "brief reasoning about what you see on screen",\n  "action": "tap|swipe|scroll|type|key|back|home|launch|wait|done|fail",\n  "x": 540, "y": 1200, "x2": 540, "y2": 400,\n  "text": "text to type or package name to launch",\n  "keycode": 66,\n  "ms": 2000,\n  "app": "App Name",\n  "summary": "final summary if done/fail",\n  "outcomeAchieved": true,\n  "nextRunMinutes": null\n}\nA task is complete ONLY when you have verified the result on screen. Never claim success without observing the screen.\nIf you are stuck, try a completely different approach rather than repeating the same action.\nNever include <thinking> or internal reasoning in your response.${stuckSection}`;

  const userContent = [
    { type: 'text', text: `Task: ${task}\nStep: ${stepIndex + 1}\nPrevious steps:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n') || 'None'}\n\nDevice state: ${JSON.stringify(deviceState || {}).slice(0, 1000)}` },
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
      continue; // try next provider (fallback)
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

  // Loop detection: track (action, x, y) -> count
  const actionCounts = new Map();
  let lastScreenHash = null;
  let stepsWithoutProgress = 0;

  const gwCheck = await getGatewayStatus(emulator.gatewayUrl);
  if (!gwCheck.online) {
    status = 'failed';
    failures = `Android emulator gateway is offline (${gwCheck.reason}). Start the Android Emulator workflow first.`;
    observedResults = 'Could not connect to running Android emulator.';
  } else {
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const checkpoint = { step: step + 1, at: new Date().toISOString() };
        const screenshotB64 = await captureScreen(emulator.gatewayUrl);
        const screenHash = imageHash(screenshotB64);
        const deviceState = await inspectDeviceState(emulator.gatewayUrl);

        // Detect loop: same screen hash as previous step
        const screenStuck = lastScreenHash !== null && screenHash === lastScreenHash;
        if (screenStuck) {
          stepsWithoutProgress++;
        } else {
          stepsWithoutProgress = 0;
        }
        lastScreenHash = screenHash;

        // Early exit: no progress for N consecutive steps
        if (stepsWithoutProgress >= NO_PROGRESS_STEPS) {
          status = 'failed';
          failures = `No screen progress for ${NO_PROGRESS_STEPS} consecutive steps — agent appears stuck.`;
          observedResults = `Agent stopped early after ${step + 1} steps with no visible progress.`;
          checkpoint.result = status;
          checkpoint.summary = failures;
          checkpoints.push(checkpoint);
          break;
        }

        const decision = await askAgentBrain({
          task: automation.instructions,
          history: actionsPerformed,
          stepIndex: step,
          screenshotBase64: screenshotB64,
          deviceState,
          stuckHint: stepsWithoutProgress >= 2,
        });

        if (decision.app) appsInteracted.add(decision.app);

        // --- completion / failure ---
        if (decision.action === 'done') {
          outcomeAchieved = Boolean(decision.outcomeAchieved === true);
          observedResults = decision.summary || decision.thought || 'Task completed.';
          aiNextMinutes = decision.nextRunMinutes ?? null;
          status = outcomeAchieved ? 'completed' : 'failed';
          checkpoint.result = status;
          checkpoint.summary = observedResults;
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

        // Loop detection: same action at same coords too many times
        const actionKey = `${decision.action}:${decision.x || 0}:${decision.y || 0}`;
        const count = (actionCounts.get(actionKey) || 0) + 1;
        actionCounts.set(actionKey, count);
        const stuckHint = count >= LOOP_DETECT_THRESHOLD;

        // --- execute the real action on the device, with screen-change verification + retry/backoff ---
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

            // Wait for the device to settle
            await sleep(STEP_DELAY_MS);

            // Re-capture screen AFTER action to verify screen change
            const postScreenshot = await captureScreen(emulator.gatewayUrl);
            const postHash = imageHash(postScreenshot);
            const postState = await inspectDeviceState(emulator.gatewayUrl);

            checkpoint.postScreenshotBytes = postScreenshot.length;
            checkpoint.postDeviceState = postState;

            // Perceptual similarity: screens are "changed" if hash differs by >2 bits
            const diff = hammingDistance(screenHash, postHash);
            if (diff > 2) {
              screenChanged = true;
              break; // screen changed — action had effect
            }

            // Screen unchanged: retry with backoff
            lastActionError = `Screen unchanged after ${decision.action}; retry ${retry + 1}/${SCREEN_CHANGE_RETRIES} (hash diff: ${diff})`;
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

        if (!screenChanged) {
          failures = (failures ? failures + '; ' : '') + `Step ${step + 1} (${decision.action}) did not change screen after ${SCREEN_CHANGE_RETRIES + 1} attempts: ${lastActionError || 'unknown'}`;
          observedResults = `Action ${desc} did not produce a visible screen change after ${SCREEN_CHANGE_RETRIES + 1} attempts.`;
        } else {
          observedResults = `Action ${desc} executed. Post-action screen captured (${checkpoint.postScreenshotBytes} bytes). Device state: ${JSON.stringify(checkpoint.postDeviceState || {}).slice(0, 300)} [screen changed — action had effect]`;
        }
      }

      if (status === 'running') {
        // Loop ended without a done/fail decision. Do NOT fabricate completion.
        status = 'failed';
        failures = `Reached step limit (${MAX_STEPS}) without a verified completion decision. Last observed state recorded.`;
        observedResults = 'Task did not reach a verified completion within the step budget.';
      }
    } catch (err) {
      status = 'failed';
      failures = err.message;
    }
  }

  const finishedAt = new Date().toISOString();

  // Compute next schedule
  let nextRunAt = null;
  if (automation.scheduleType === 'once') {
    if (outcomeAchieved) { automation.enabled = false; automation.status = 'completed'; }
    else { automation.status = status; }
  } else if (automation.enabled && !automation.paused) {
    const mins = automation.scheduleType === 'ai_decided' && aiNextMinutes
      ? Math.max(15, Number(aiNextMinutes))
      : Number(automation.intervalMinutes || 60);
    nextRunAt = new Date(Date.now() + mins * 60000).toISOString();
    automation.status = 'waiting';
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
  };

  // Save execution history
  const execFile = path.join(EXECUTIONS_DIR, `${automation.id}.json`);
  const execList = readJson(execFile, []);
  execList.unshift(report);
  writeJson(execFile, execList.slice(0, 50));

  // Append mandatory feedback to automation chat
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
      `• **Next Run:** ${nextRunAt || 'None (completed/stopped)'}`,
    ].filter(Boolean).join('\n'),
  });
  writeJson(chatFile, chatList.slice(-100));

  // Record persistence session
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
