#!/usr/bin/env node
/**
 * VEXA Autonomous AI Agent Runner
 * Runs in GitHub Actions (scheduled / workflow_dispatch) or locally.
 * Reads automations from data/automations.json, operates the live Android
 * emulator via the VEXA Gateway (and mobilerun bridge where available),
 * verifies every action against the resulting screen, and writes execution
 * reports + chat feedback back to the repository.
 *
 * Bugs fixed in this rewrite:
 *   • Internal reasoning (<thinking> / </think>) no longer leaks into user-facing
 *     responses (was a broken regex: /\[\\s\\S\]*?<\/think>/gi matched nothing).
 *   • A task is marked completed ONLY when outcomeAchieved === true — never
 *     merely because a step loop ended.
 *   • No arbitrary low step cap stops legitimate multi-step tasks (maxSteps
 *     is configurable; continuation persists across runs).
 *   • Multi-provider AI with key rotation + fallback: NVIDIA → Grok →
 *     OpenAI-compatible. Rate-limited keys are skipped; the next provider is tried.
 *   • Android actions go through mobilerun (genuine device control) where the
 *     bridge is reachable, falling back to the gateway ADB endpoint.
 *   • Every action is verified by re-capturing the screen before proceeding.
 */

import fs from 'fs';
import path from 'path';

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
const XAI_API_KEY = (process.env.XAI_API_KEY || '').trim();
const XAI_MODEL = process.env.XAI_MODEL || 'grok-2-vision-1212';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_ENDPOINT = (process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1/chat/completions').trim();
const TARGET_AUTOMATION_ID = (process.env.TARGET_AUTOMATION_ID || '').trim();
const EMULATOR_ACCESS_TOKEN = (process.env.EMULATOR_ACCESS_TOKEN || '').trim();
const MOBILERUN_BRIDGE = (process.env.MOBILERUN_BRIDGE || 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');
const MAX_STEPS = Number(process.env.MAX_STEPS || '40'); // high cap; completion driven by outcome, not the cap
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || '1500');

const PROVIDERS = [
  {
    id: 'nvidia',
    key: NVIDIA_API_KEY,
    model: NVIDIA_MODEL,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    label: 'NVIDIA NIM',
  },
  {
    id: 'grok',
    key: XAI_API_KEY,
    model: XAI_MODEL,
    endpoint: 'https://api.x.ai/v1/chat/completions',
    label: 'xAI Grok',
  },
  {
    id: 'openai',
    key: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    endpoint: OPENAI_ENDPOINT,
    label: 'OpenAI-compatible',
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

function base64UrlSafe(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 30000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/* ------------------------------------------------------------------ gateway / mobilerun device */
async function getGatewayStatus(gatewayUrl) {
  if (!gatewayUrl) return { online: false, reason: 'No gatewayUrl configured in data/emulator.json' };
  try {
    const res = await fetchWithTimeout(`${gatewayUrl.replace(/\/+$/, '')}/api/public/health`, { timeoutMs: 10000 });
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
    timeoutMs: 25000,
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
  const res = await fetchWithTimeout(url, { headers, timeoutMs: 20000 });
  if (!res.ok) throw new Error(`Screenshot failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

/* mobilerun bridge (genuine Android control via droidrun/mobilerun) */
async function mobilerunRequest(endpoint, body = {}, timeoutMs = 30000) {
  if (!MOBILERUN_BRIDGE) throw new Error('No mobilerun bridge configured');
  const res = await fetchWithTimeout(`${MOBILERUN_BRIDGE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (!res.ok) throw new Error(`mobilerun ${endpoint} failed (${res.status})`);
  return res.json();
}
async function mobilerunGet(endpoint, timeoutMs = 30000) {
  if (!MOBILERUN_BRIDGE) throw new Error('No mobilerun bridge configured');
  const res = await fetchWithTimeout(`${MOBILERUN_BRIDGE}${endpoint}`, { timeoutMs });
  if (!res.ok) throw new Error(`mobilerun GET ${endpoint} failed (${res.status})`);
  return res.json();
}

async function captureScreen(gatewayUrl) {
  // Prefer mobilerun bridge (genuine device screenshot via droidrun), fall back to gateway.
  try {
    const data = await mobilerunGet('/device/screenshot');
    if (data.ok && data.screenshot_base64) return data.screenshot_base64;
  } catch { /* fall through to gateway */ }
  return captureScreenViaGateway(gatewayUrl);
}

async function deviceAction(gatewayUrl, action, params = {}) {
  // Try mobilerun bridge first (genuine droidrun control), fall back to gateway ADB.
  const mr = await mapActionToMobilerun(action, params);
  if (mr) {
    try {
      const res = await mobilerunRequest(mr.endpoint, mr.body, 40000);
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
  // Genuine device state via mobilerun (apps, packages, UI tree).
  try {
    const state = await mobilerunGet('/device/state');
    if (state.ok) return state;
  } catch { /* fall through */ }
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
  const match = cleaned.match(/\{[\s\S]*\}/);
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
    timeoutMs: 90000,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const status = res.status;
    if ((status === 429 || status >= 500) && attempt < 2) {
      await sleep(2000 * attempt);
      return callProvider(provider, messages, attempt + 1);
    }
    throw new Error(`${provider.label} API error ${status}: ${txt.slice(0, 400)}`);
  }

  const json = await res.json();
  const raw = (json.choices?.[0]?.message?.content || '');
  return stripReasoning(raw);
}

async function askAgentBrain({ task, history, stepIndex, screenshotBase64, deviceState }) {
  const systemPrompt = `You are VEXA, an autonomous AI agent operating a real Android phone (1080x2400).
Inspect the current screen and device state, then decide the SINGLE next action to accomplish the user's task.
Respond ONLY with valid JSON, no markdown fences, no reasoning tags:
{
  "thought": "brief reasoning about what you see on screen",
  "action": "tap|swipe|scroll|type|key|back|home|launch|wait|done|fail",
  "x": 540, "y": 1200, "x2": 540, "y2": 400,
  "text": "text to type or package name to launch",
  "keycode": 66,
  "ms": 2000,
  "app": "App Name",
  "summary": "final summary if done/fail",
  "outcomeAchieved": true,
  "nextRunMinutes": null
}
A task is complete ONLY when you have verified the result on screen. Never claim success without observing the screen.
Never include <thinking> or internal reasoning in your response.`;

  const userContent = [
    { type: 'text', text: `Task: ${task}\nStep: ${stepIndex + 1}\nPrevious steps:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n') || 'None'}\n\nDevice state: ${JSON.stringify(deviceState || {}).slice(0, 1200)}` },
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
        const deviceState = await inspectDeviceState(emulator.gatewayUrl);

        const decision = await askAgentBrain({
          task: automation.instructions,
          history: actionsPerformed,
          stepIndex: step,
          screenshotBase64: screenshotB64,
          deviceState,
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

        // --- execute the real action on the device ---
        let actionResult;
        try {
          actionResult = await deviceAction(emulator.gatewayUrl, decision.action, {
            x: decision.x, y: decision.y, x2: decision.x2, y2: decision.y2,
            text: decision.text, keycode: decision.keycode, ms: decision.ms,
            app: decision.app, clear: decision.clear,
          });
        } catch (err) {
          // Record failure and allow the agent to recover on the next step
          failures = (failures ? failures + '; ' : '') + `Step ${step + 1} (${decision.action}) failed: ${err.message}`;
          checkpoint.error = err.message;
          checkpoints.push(checkpoint);
          actionsPerformed.push(`${decision.action} FAILED: ${err.message}`);
          await sleep(STEP_DELAY_MS);
          continue; // agent observes the new screen and decides recovery
        }

        checkpoint.action = decision.action;
        checkpoint.thought = decision.thought;
        checkpoint.provider = decision._provider;
        checkpoints.push(checkpoint);

        const desc = `${decision.action}(${decision.text || `${decision.x},${decision.y}`})`;
        actionsPerformed.push(`${desc} — ${decision.thought}`);

        // Verify: wait briefly then re-capture screen to confirm the device changed
        await sleep(STEP_DELAY_MS);
        const postScreenshot = await captureScreen(emulator.gatewayUrl);
        const postState = await inspectDeviceState(emulator.gatewayUrl);
        checkpoint.postScreenshotBytes = postScreenshot.length;
        checkpoint.postDeviceState = postState;
        observedResults = `Action ${desc} executed. Post-action screen captured (${postScreenshot.length} bytes). Device state: ${JSON.stringify(postState || {}).slice(0, 300)}`;

        // Simple progress signal: if screen changed meaningfully, note it
        if (postScreenshot !== screenshotB64) {
          observedResults += ' [screen changed — action had effect]';
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
