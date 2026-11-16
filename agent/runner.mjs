#!/usr/bin/env node
/**
 * VEXA Autonomous AI Agent Runner
 * Runs in GitHub Actions (scheduled / workflow_dispatch) or locally.
 * Reads automations from data/automations.json, operates the live Android
 * emulator via the VEXA Gateway, verifies every action, and writes
 * execution reports + chat feedback back to the repository.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();
const DATA_DIR = path.join(REPO_ROOT, 'data');
const AUTOMATIONS_FILE = path.join(DATA_DIR, 'automations.json');
const EMULATOR_FILE = path.join(DATA_DIR, 'emulator.json');
const EXECUTIONS_DIR = path.join(DATA_DIR, 'executions');
const CHATS_DIR = path.join(DATA_DIR, 'chats');

const NVIDIA_API_KEY = (process.env.NVIDIA_API_KEY || '').trim();
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-4-maverick-17b-128e-instruct';
const TARGET_AUTOMATION_ID = (process.env.TARGET_AUTOMATION_ID || '').trim();
const EMULATOR_ACCESS_TOKEN = (process.env.EMULATOR_ACCESS_TOKEN || '').trim();

fs.mkdirSync(EXECUTIONS_DIR, { recursive: true });
fs.mkdirSync(CHATS_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getGatewayStatus(gatewayUrl) {
  if (!gatewayUrl) return { online: false, reason: 'No gatewayUrl configured in data/emulator.json' };
  try {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/api/public/health`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { online: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { online: true, data };
  } catch (err) {
    return { online: false, reason: err.message };
  }
}

async function gatewayRpc(gatewayUrl, action, params = {}) {
  const url = `${gatewayUrl.replace(/\/$/, '')}/api/agent/action`;
  const headers = { 'Content-Type': 'application/json' };
  if (EMULATOR_ACCESS_TOKEN) headers['Authorization'] = `Bearer ${EMULATOR_ACCESS_TOKEN}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...params }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gateway action ${action} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function captureScreen(gatewayUrl) {
  const url = `${gatewayUrl.replace(/\/$/, '')}/api/public/screenshot`;
  const headers = {};
  if (EMULATOR_ACCESS_TOKEN) headers['Authorization'] = `Bearer ${EMULATOR_ACCESS_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Screenshot failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

async function askAgentBrain({ task, history, stepIndex, screenshotBase64 }) {
  if (!NVIDIA_API_KEY) {
    throw new Error('NVIDIA_API_KEY is not configured');
  }

  const systemPrompt = `You are VEXA, an autonomous AI agent operating a real Android phone (1080x2400).
You must inspect the current screen and decide the SINGLE next action to accomplish the user's task.
Respond ONLY with valid JSON:
{
  "thought": "brief reasoning about what you see on screen",
  "action": "tap" | "swipe" | "type" | "key" | "launch" | "back" | "home" | "wait" | "done" | "fail",
  "x": 540,
  "y": 1200,
  "x2": 540,
  "y2": 400,
  "text": "text to type or package name to launch",
  "keycode": 66,
  "ms": 2000,
  "app": "App Name",
  "summary": "final summary if done/fail",
  "outcomeAchieved": true,
  "nextRunMinutes": null
}`;

  const userContent = [
    {
      type: 'text',
      text: `Task: ${task}\nStep: ${stepIndex + 1}/15\nPrevious steps:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n') || 'None'}`,
    },
  ];

  if (screenshotBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
    });
  }

  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`NVIDIA API error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Agent returned non-JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function runAutomation(automation, emulator) {
  const startedAt = new Date().toISOString();
  const execId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const actionsPerformed = [];
  const appsInteracted = new Set();
  let observedResults = '';
  let outcomeAchieved = false;
  let failures = null;
  let remainingSteps = [];
  let status = 'running';
  let aiNextMinutes = null;

  const gwCheck = await getGatewayStatus(emulator.gatewayUrl);
  if (!gwCheck.online) {
    status = 'failed';
    failures = `Android emulator gateway is offline (${gwCheck.reason}). Start the Android Emulator workflow first.`;
    observedResults = 'Could not connect to running Android emulator.';
  } else {
    try {
      for (let step = 0; step < 15; step++) {
        const screenshotB64 = await captureScreen(emulator.gatewayUrl);
        const decision = await askAgentBrain({
          task: automation.instructions,
          history: actionsPerformed,
          stepIndex: step,
          screenshotBase64: screenshotB64,
        });

        if (decision.app) appsInteracted.add(decision.app);

        if (decision.action === 'done') {
          outcomeAchieved = Boolean(decision.outcomeAchieved ?? true);
          observedResults = decision.summary || decision.thought || 'Task completed.';
          aiNextMinutes = decision.nextRunMinutes ?? null;
          status = outcomeAchieved ? 'completed' : 'failed';
          break;
        }

        if (decision.action === 'fail') {
          outcomeAchieved = false;
          failures = decision.summary || decision.thought || 'Agent reported task could not be completed.';
          status = 'failed';
          break;
        }

        // Execute real action on emulator
        await gatewayRpc(emulator.gatewayUrl, decision.action, decision);
        actionsPerformed.push(`${decision.action}(${decision.text || `${decision.x || ''},${decision.y || ''}`}) — ${decision.thought}`);
        await sleep(1500);
      }

      if (status === 'running') {
        status = 'completed';
        observedResults = 'Reached step limit; last observed state recorded.';
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
    if (outcomeAchieved) {
      automation.enabled = false;
      automation.status = 'completed';
    } else {
      automation.status = status;
    }
  } else if (automation.enabled && !automation.paused) {
    const mins =
      automation.scheduleType === 'ai_decided' && aiNextMinutes
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
    remainingSteps,
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
      `• **Actions:** ${actionsPerformed.length ? actionsPerformed.join(' → ') : 'None'}`,
      `• **Apps:** ${report.appsInteracted.length ? report.appsInteracted.join(', ') : 'None'}`,
      `• **Observed:** ${observedResults || 'N/A'}`,
      failures ? `• **Failures:** ${failures}` : null,
      `• **Next Run:** ${nextRunAt || 'None (completed/stopped)'}`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
  writeJson(chatFile, chatList.slice(-100));

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
    console.log(`Running automation ${auto.id} (${auto.name})...`);
    await runAutomation(auto, emulator);
  }

  writeJson(AUTOMATIONS_FILE, automations);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
