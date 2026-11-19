/**
 * VEXA autonomous agent loop.
 *
 * The chat endpoint used to be a single blocking call: one model turn, one
 * optional ACTION line, one JSON blob. The agent could not see the result of its
 * own action, could not take a second step, and streamed nothing — the user
 * stared at a spinner for the whole round trip and then got a wall of text.
 *
 * This module runs a real agent loop instead:
 *
 *   observe → plan (one model turn) → act (one device action) → wait for the
 *   device to report the result → observe the new frame → repeat
 *
 * Every step appends a genuine `agent_events` row. Those rows are what the SSE
 * stream forwards to the browser, so the chat shows what actually happened,
 * in order, as it happens. Nothing here is fabricated: an event is written only
 * after the corresponding operation returned, and a device action is only
 * reported as executed once the emulator posted its result back.
 *
 * Bounded by design — a step cap, a wall-clock deadline, and a cancellation flag
 * polled between steps — so a task cannot loop forever.
 */

import {
  appendAgentEvent, getDeviceState, claimDeviceAction, getEmulatorSession,
} from './database.js';
import { normalizeDeviceAction, resolutionFromSession, DEFAULT_RESOLUTION } from './device-actions.js';

export const MAX_STEPS = 20;
// Each step costs one model round-trip plus one device round-trip. At ~15s per
// model call a 110s budget only bought five steps, so ordinary tasks (open an
// app, read a value) ran out of time mid-way. The run is streamed, and CPU time
// stays near zero because every step is waiting on I/O.
export const DEADLINE_MS = 240_000;
const ACTION_TIMEOUT_MS = 12_000;
const ACTION_POLL_MS = 300;

const SYSTEM_PROMPT = `You are VEXA, an autonomous agent operating a real Android phone.

You work in a loop: you receive the current screen (a screenshot and/or the on-screen text), you decide the single next step, and the system executes it and shows you the result.

Reply with EXACTLY ONE of these two forms, nothing else:

1) To take a step on the phone:
THOUGHT: <one short sentence of reasoning>
ACTION: {"action":"tap","x":540,"y":1200}

2) When the task is finished or cannot proceed:
THOUGHT: <one short sentence>
DONE: <the final answer or report for the user, with what you actually observed>

Action schema:
- {"action":"tap","x":<px>,"y":<px>}          — tap a point
- {"action":"swipe","x":<px>,"y":<px>,"x2":<px>,"y2":<px>,"ms":300}
- {"action":"scroll","x":<px>,"y":<px>,"y2":<px>}   — scroll down
- {"action":"type","text":"..."}                — type into the focused field
- {"action":"key","keycode":66}                 — 66=Enter, 4=Back, 3=Home
- {"action":"back"} / {"action":"home"} / {"action":"recents"}
- {"action":"launch","app":"Settings"}           — open an app by name
- {"action":"wait","ms":2000}                    — let the screen settle

Rules:
- Each element in the observation is listed as: - "<label>" tap(x,y) [clickable].
  That tap(x,y) is the centre of the element's real bounds — use it verbatim.
  Never estimate a coordinate for an element that is listed.
- Coordinates are integer PIXELS in the device's own resolution, origin top-left.
- Take ONE action per reply. You will see the resulting screen before deciding the next one.
- Only when an element is absent from the list should you estimate from the screenshot.
- If a dialog, permission prompt, or notification blocks the way, dismiss it first.
- Do not repeat an action that just failed to change the screen; try a different approach.
- When you have the answer the user asked for, reply with DONE and state what you observed on screen.`;

/** Thrown when a run is cancelled by the caller (stop button). */
class CancelledError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Emit one real activity event. Wrapped so a logging failure can never abort a
 * run — the event feed is observability, the device work is the job.
 */
async function emit(db, ctx, event) {
  try {
    const seq = await appendAgentEvent(db, {
      conversationId: ctx.conversationId,
      automationId: ctx.automationId,
      executionId: ctx.executionId,
      ...event,
    });
    ctx.onEvent?.({ ...event, seq });
    return seq;
  } catch (err) {
    console.warn(`agent event skipped: ${err.message}`);
    return null;
  }
}

/**
 * Parse the uiautomator XML tree into tappable elements.
 *
 * The bounds matter as much as the label: a model told only "GOT IT" guesses a
 * tap position and misses the button, then retries the same wrong coordinate.
 * Each element therefore carries the centre of its own bounds.
 */
export function uiElements(uiHierarchy, limit = 60) {
  if (!uiHierarchy) return [];
  let raw = uiHierarchy;
  try {
    if (typeof raw === 'string' && raw.startsWith('DUMPSYS_WINDOWS:')) return [];
    raw = typeof atob === 'function'
      ? atob(uiHierarchy)
      : Buffer.from(uiHierarchy, 'base64').toString('utf8');
  } catch {
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const m of String(raw).matchAll(/<node\b[^>]*>/g)) {
    const tag = m[0];
    const attr = (name) => {
      const found = tag.match(new RegExp(`${name}="([^"]*)"`));
      return found ? found[1] : '';
    };
    const label = (attr('text') || attr('content-desc') || '').trim();
    if (!label || label.length > 120) continue;
    const bounds = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) continue;
    // Several nodes share a label (a container and its text). Keep the innermost
    // one — the smallest box is the element a finger would actually hit.
    const key = label.toLowerCase();
    const el = {
      label,
      x: Math.round(x1 + w / 2),
      y: Math.round(y1 + h / 2),
      clickable: attr('clickable') === 'true',
      area: w * h,
    };
    const prev = seen.has(key) ? out.findIndex((e) => e.label.toLowerCase() === key) : -1;
    if (prev >= 0) {
      if (el.area < out[prev].area) out[prev] = el;
    } else {
      seen.add(key);
      out.push(el);
    }
  }
  // Clickable elements first: they are what the task is usually about.
  out.sort((a, b) => Number(b.clickable) - Number(a.clickable) || a.area - b.area);
  return out.slice(0, limit);
}

/** Extract readable labels from the uiautomator XML tree (base64 or raw). */
export function uiLabels(uiHierarchy, limit = 70) {
  return uiElements(uiHierarchy, limit).map((e) => e.label);
}

/**
 * Cheap fingerprint of what the screen actually offers: its rendered text plus
 * element count. Used to tell a real navigation apart from a repaint.
 */
export function uiSignature(uiHierarchy) {
  const elements = uiElements(uiHierarchy);
  if (!elements.length) return null;
  const text = elements.map((e) => e.label).join('\u0001');
  return `${elements.length}:${text}`;
}

/**
 * Build the observation block handed to the model: each on-screen element with
 * the coordinate to tap, plus the live frame when one is attachable.
 */
export function buildObservation(state, { resolution } = {}) {
  const elements = uiElements(state?.uiHierarchy);
  const frame = state?.lastScreenshotUrl || '';
  const attachable = /^data:image\/(png|jpe?g|webp);base64,/.test(frame) && frame.length < 6_000_000;
  const lines = [];
  if (elements.length) {
    lines.push('On-screen elements (label -> tap coordinate):');
    for (const el of elements) {
      lines.push(`- "${el.label}" tap(${el.x},${el.y})${el.clickable ? ' [clickable]' : ''}`);
    }
  } else {
    lines.push('On-screen elements: none exposed — rely on the screenshot and estimate coordinates.');
  }
  if (resolution?.width) lines.push(`Device resolution: ${resolution.width}x${resolution.height} px`);
  return { text: lines.join('\n'), frame: attachable ? frame : null, labels: elements.map((e) => e.label) };
}

/** Parse a model reply into a thought plus either an action or a final answer. */
export function parseStep(reply) {
  const text = String(reply || '');
  const thought = (text.match(/THOUGHT:\s*(.+)/) || [])[1]?.trim() || '';
  const doneMatch = text.match(/DONE:\s*([\s\S]+)/);
  if (doneMatch) {
    return { thought, done: true, answer: doneMatch[1].trim() };
  }
  const actionMatch = text.match(/ACTION:\s*(\{[\s\S]*?\})/);
  if (actionMatch) {
    let action;
    try {
      action = JSON.parse(actionMatch[1]);
    } catch {
      return { thought, done: false, action: null, parseError: 'ACTION was not valid JSON' };
    }
    // Models routinely express completion as an action ({"action":"done",...})
    // instead of the DONE: line. Treating that as a device command failed with
    // "Unknown action: done" and the run looped until the step cap.
    const name = String(action.action || '').toLowerCase();
    if (name === 'done' || name === 'finish' || name === 'complete') {
      return { thought, done: true, answer: String(action.text || action.answer || thought || 'Done.').trim() };
    }
    return { thought, done: false, action };
  }
  // A reply with neither marker is treated as a final answer rather than
  // silently discarded — the user asked a question and deserves the response.
  return { thought, done: true, answer: text.trim() };
}

/** True when the device session is currently considered live. */
export function isSessionOnline(session, maxAgeMs = 5 * 60 * 1000) {
  return !!session
    && session.status === 'online'
    && Date.now() - new Date(session.lastHeartbeat || 0).getTime() < maxAgeMs;
}

/**
 * Queue one device action and wait for the emulator to report the result.
 *
 * Returns { executed, error, state } where `state` is the device state *after*
 * the action — the emulator uploads a fresh frame with its result, so the caller
 * can observe the consequence of what it just did.
 */
async function executeAction(env, action, ctx) {
  const clientId = `agent_${ctx.runId}_${ctx.step}`;
  const claimed = await claimDeviceAction(env.DB, { action, clientId });
  if (!claimed) {
    return { executed: false, error: 'another action is already pending on the device', state: null };
  }

  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ctx.isCancelled()) throw new CancelledError('cancelled');
    await sleep(ACTION_POLL_MS);
    const state = await getDeviceState(env.DB);
    if (!state) continue;
    if (state.lastActionClientId !== clientId) continue;
    if (state.lastActionStatus === 'pending') continue;

    let result = null;
    try {
      result = state.lastActionResult ? JSON.parse(state.lastActionResult) : null;
    } catch { /* legacy plain-text result */ }
    const ok = result ? result.success !== false : true;
    return {
      executed: ok,
      error: ok ? null : (result?.error || 'the device reported the action failed'),
      state,
    };
  }
  return { executed: false, error: `no result from the device within ${ACTION_TIMEOUT_MS / 1000}s`, state: null };
}

/**
 * Run one autonomous task to completion.
 *
 * @param {object} env              Worker env (DB required)
 * @param {object} ctx              { conversationId, automationId, executionId, runId, task,
 *                                    askAi, isCancelled, onEvent, history }
 * @returns {Promise<{ok, answer, steps, actions, cancelled, error, events}>}
 */
export async function runAgentTask(env, ctx) {
  const startedAt = Date.now();
  const deadline = startedAt + DEADLINE_MS;
  const history = Array.isArray(ctx.history) ? ctx.history.slice(-8) : [];
  const events = [];
  const record = (e) => { events.push(e); };
  const wrappedCtx = { ...ctx, onEvent: (e) => { record(e); ctx.onEvent?.(e); } };

  const session = await getEmulatorSession(env.DB);
  const resolution = resolutionFromSession(session) || DEFAULT_RESOLUTION;

  await emit(env.DB, wrappedCtx, {
    kind: 'plan',
    title: 'Task received',
    detail: ctx.task,
    status: 'running',
  });

  if (!isSessionOnline(session)) {
    const message = 'The Android device is offline, so I cannot observe or control the phone. Start the emulator and try again.';
    await emit(env.DB, wrappedCtx, { kind: 'error', title: 'Device offline', detail: message, status: 'failed' });
    return { ok: false, answer: message, steps: 0, actions: 0, cancelled: false, error: 'device offline', events };
  }

  await emit(env.DB, wrappedCtx, {
    kind: 'observe',
    title: 'Connected to device',
    detail: `${session.deviceModel || 'Android'} ${session.androidVersion || ''} · ${resolution.width}x${resolution.height}`.trim(),
    status: 'done',
  });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((h) => ({
      role: h.role === 'agent' ? 'assistant' : 'user',
      content: String(h.content || '').slice(0, 1500),
    })),
    { role: 'user', content: `TASK: ${ctx.task}` },
  ];

  let step = 0;
  let actionsTaken = 0;
  let lastSignature = null;
  let repeatCount = 0;
  let pendingNote = '';

  while (step < MAX_STEPS && Date.now() < deadline) {
    if (ctx.isCancelled()) {
      await emit(env.DB, wrappedCtx, { kind: 'cancelled', title: 'Task cancelled', detail: 'Stopped by the operator.', status: 'failed' });
      return { ok: false, answer: 'Task cancelled.', steps: step, actions: actionsTaken, cancelled: true, error: 'cancelled', events };
    }
    step += 1;
    ctx.step = step;

    // ---- observe -------------------------------------------------------
    const state = await getDeviceState(env.DB);
    const obs = buildObservation(state, { resolution });

    // A screen that never changes across attempts means the last action did not
    // land. Say so instead of silently retrying the same thing.
    const signature = state?.screenChecksum || obs.text;
    if (signature && signature === lastSignature) {
      repeatCount += 1;
    } else {
      repeatCount = 0;
      lastSignature = signature;
    }

    await emit(env.DB, wrappedCtx, {
      kind: 'observe',
      title: `Step ${step}: reading the screen`,
      detail: obs.labels.length ? obs.labels.slice(0, 12).join(' · ') : 'no accessibility labels',
      status: 'done',
    });

    // ---- plan ----------------------------------------------------------
    const userContent = [];
    const obsText = `STEP ${step} of at most ${MAX_STEPS}.\n${obs.text}${
      pendingNote ? `\n\n${pendingNote}` : ''
    }`;
    pendingNote = '';
    userContent.push({ type: 'text', text: obsText });
    if (obs.frame) userContent.push({ type: 'image_url', image_url: { url: obs.frame } });
    messages.push({ role: 'user', content: obs.frame ? userContent : obsText });

    await emit(env.DB, wrappedCtx, { kind: 'thinking', title: `Step ${step}: deciding the next move`, status: 'running' });

    const ai = await ctx.askAi({ messages });
    if (!ai.ok) {
      await emit(env.DB, wrappedCtx, { kind: 'error', title: 'The AI provider failed', detail: ai.error, status: 'failed' });
      return { ok: false, answer: `I could not reach the AI provider: ${ai.error}`, steps: step, actions: actionsTaken, cancelled: false, error: ai.error, events };
    }
    messages.push({ role: 'assistant', content: ai.content });

    const parsed = parseStep(ai.content);
    if (parsed.thought) {
      await emit(env.DB, wrappedCtx, { kind: 'thinking', title: parsed.thought, status: 'done' });
    }

    if (parsed.done) {
      await emit(env.DB, wrappedCtx, {
        kind: 'verify',
        title: 'Task complete',
        detail: parsed.answer,
        status: 'done',
      });
      return { ok: true, answer: parsed.answer, steps: step, actions: actionsTaken, cancelled: false, error: null, events };
    }

    if (!parsed.action) {
      await emit(env.DB, wrappedCtx, {
        kind: 'error',
        title: 'Could not interpret the next step',
        detail: parsed.parseError || ai.content.slice(0, 300),
        status: 'failed',
      });
      continue;
    }

    // ---- act -----------------------------------------------------------
    const action = normalizeDeviceAction(parsed.action, resolution);
    if (!action || !action.action) {
      await emit(env.DB, wrappedCtx, { kind: 'error', title: 'Invalid action', detail: JSON.stringify(parsed.action).slice(0, 200), status: 'failed' });
      continue;
    }

    await emit(env.DB, wrappedCtx, {
      kind: 'tool',
      title: `Step ${step}: ${describeAction(action)}`,
      detail: JSON.stringify(action),
      status: 'running',
    });

    let outcome;
    const signatureBefore = state?.screenChecksum || null;
    const uiBefore = uiSignature(state?.uiHierarchy);
    try {
      outcome = await executeAction(env, action, wrappedCtx);
    } catch (err) {
      if (err instanceof CancelledError) {
        await emit(env.DB, wrappedCtx, { kind: 'cancelled', title: 'Task cancelled', detail: 'Stopped by the operator.', status: 'failed' });
        return { ok: false, answer: 'Task cancelled.', steps: step, actions: actionsTaken, cancelled: true, error: 'cancelled', events };
      }
      throw err;
    }
    actionsTaken += 1;

    if (!outcome.executed) {
      await emit(env.DB, wrappedCtx, {
        kind: 'error',
        title: `Step ${step}: action failed`,
        detail: outcome.error || 'unknown error',
        status: 'failed',
      });
      pendingNote = `The action ${JSON.stringify(action)} FAILED: ${outcome.error}. `
        + 'Do not repeat it unchanged — choose a different approach.';
      continue;
    }

    // Only claim the screen moved when the checksum actually moved. Reporting
    // "screen updated" for a no-op action hid the fact that taps were missing.
    //
    // The checksum is not enough on its own: a ripple, a scroll animation, or a
    // spinner repaints pixels without changing what the screen offers, so an
    // action that did nothing could still look effective and the agent would
    // repeat it. When the UI tree is available its text is the honest signal —
    // it only changes when the screen actually offers something different — so
    // require both. Without a UI tree, fall back to pixels alone.
    const signatureAfter = outcome.state?.screenChecksum || null;
    const uiAfter = uiSignature(outcome.state?.uiHierarchy);
    const pixelsMoved = Boolean(signatureBefore && signatureAfter && signatureBefore !== signatureAfter);
    const uiMoved = Boolean(uiBefore && uiAfter && uiBefore !== uiAfter);
    const screenMoved = uiBefore && uiAfter ? pixelsMoved && uiMoved : pixelsMoved;
    await emit(env.DB, wrappedCtx, {
      kind: 'tool',
      title: `Step ${step}: executed`,
      detail: `${describeAction(action)} — ${screenMoved ? 'screen updated' : 'screen unchanged'}`,
      status: screenMoved ? 'done' : 'running',
    });

    if (repeatCount >= 2) {
      pendingNote = 'The screen has not changed across your last attempts. That action is not '
        + 'working — try a different element or approach, or report that you are blocked.';
    }
  }

  const timedOut = Date.now() >= deadline;
  const message = timedOut
    ? `I ran out of time after ${step} steps. The task is not finished.`
    : `I reached the ${MAX_STEPS}-step limit without finishing. The task is not complete.`;
  await emit(env.DB, wrappedCtx, {
    kind: 'verify',
    title: timedOut ? 'Stopped: time limit' : 'Stopped: step limit',
    detail: message,
    status: 'failed',
  });
  return { ok: false, answer: message, steps: step, actions: actionsTaken, cancelled: false, error: timedOut ? 'timeout' : 'step limit', events };
}

/** Human-readable summary of a device action, for the activity feed. */
export function describeAction(action) {
  switch (action?.action) {
    case 'tap': return `Tap (${action.x}, ${action.y})`;
    case 'swipe': return `Swipe (${action.x}, ${action.y}) → (${action.x2}, ${action.y2})`;
    case 'scroll': return `Scroll from y=${action.y} to y=${action.y2}`;
    case 'type': return `Type "${String(action.text || '').slice(0, 40)}"`;
    case 'key': return `Key event ${action.keycode}`;
    case 'launch': return `Open ${action.app || action.text || 'app'}`;
    case 'back': return 'Back';
    case 'home': return 'Home';
    case 'recents': return 'Recent apps';
    case 'wait': return `Wait ${action.ms || 2000}ms`;
    case 'screenshot': return 'Refresh the screen';
    default: return String(action?.action || 'unknown action');
  }
}
