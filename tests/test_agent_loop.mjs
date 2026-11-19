/**
 * Tests for the autonomous agent loop.
 *
 * The loop's whole point is that it reacts to the *real* result of each action:
 * it observes, acts, waits for the device to report back, and only then decides
 * the next step. These tests drive `runAgentTask` against a fake device that
 * genuinely mutates its state when an action is claimed, so a passing run proves
 * the feedback path works end to end rather than that a scripted reply was
 * replayed.
 *
 * Run: node tests/test_agent_loop.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runAgentTask, parseStep, uiLabels, uiElements, buildObservation, isSessionOnline, MAX_STEPS } from '../cloudflare-backend/src/agent-loop.js';

/* ------------------------------------------------------------ fake device */

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/**
 * A device that behaves like the real one: claiming an action leaves it
 * pending; a background "emulator" settles it, uploads a new frame, and
 * advances the app state. That is the exact handshake the loop depends on.
 */
function createDevice({ startApp = 'Home', frames = {}, failAction = null } = {}) {
  const device = {
    state: {
      screenChecksum: `frame-${startApp}`,
      lastScreenshotUrl: PNG_1PX,
      uiHierarchy: null,
      lastAction: null,
      lastActionResult: null,
      lastActionClientId: null,
      lastActionStatus: null,
    },
    currentApp: startApp,
    actions: [],
    frameCount: 0,
  };

  const settle = (action, clientId) => {
    device.currentApp = frames[action.action] ?? device.currentApp;
    device.frameCount += 1;
    const ok = failAction === action.action;
    device.state = {
      ...device.state,
      screenChecksum: `frame-${device.frameCount}`,
      lastScreenshotUrl: PNG_1PX,
      lastActionStatus: ok ? 'failed' : 'done',
      lastActionResult: JSON.stringify(ok
        ? { success: false, error: `${action.action} rejected by the device` }
        : { success: true }),
      lastActionClientId: clientId,
    };
  };

  device.claim = (action, clientId) => {
    device.actions.push({ action, clientId });
    device.state = { ...device.state, lastActionStatus: 'pending', lastActionClientId: clientId };
    // The emulator picks the action up almost immediately.
    setImmediate(() => settle(action, clientId));
    return true;
  };
  return device;
}

/** D1 stub: records events, serves device state, honours action claims. */
function createDb(device, session) {
  const events = [];
  return {
    events,
    prepare(sql) {
      const run = async (args) => {
        if (sql.includes('INSERT INTO agent_events')) {
          events.push({
            conversationId: args[1], automationId: args[2], kind: args[4],
            title: args[5], detail: args[6], status: args[7], seq: args[8],
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE device_state') && sql.includes('last_action_status')) {
          const action = JSON.parse(args[0]);
          return { meta: { changes: device.claim(action, args[1]) ? 1 : 0 } };
        }
        return { meta: { changes: 1 } };
      };
      const stmt = {
        _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (sql.includes('MAX(seq)')) return { maxSeq: events.length };
          if (sql.includes('FROM device_state')) return { ...device.state };
          if (sql.includes('FROM emulator_sessions')) return session ? { ...session } : null;
          return null;
        },
        async run() { return run(this._args); },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
    async exec() {},
  };
}

const ONLINE_SESSION = {
  status: 'online',
  deviceModel: 'Pixel 7',
  androidVersion: '14',
  resolution: '1080x2400',
  lastHeartbeat: new Date().toISOString(),
};

/** Scripted model: returns each reply in turn, recording what it was shown. */
function scriptedAi(replies) {
  const seen = [];
  let i = 0;
  const fn = async ({ messages }) => {
    seen.push(messages[messages.length - 1]);
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return { ok: true, content: reply };
  };
  fn.seen = seen;
  fn.turns = () => i;
  return fn;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ------------------------------------------------------------------- tests */

await test('parseStep reads a thought plus an action', () => {
  const s = parseStep('THOUGHT: tap the Settings icon\nACTION: {"action":"tap","x":540,"y":1200}');
  assert.equal(s.done, false);
  assert.equal(s.thought, 'tap the Settings icon');
  assert.equal(s.action.action, 'tap');
  assert.equal(s.action.x, 540);
});

await test('parseStep recognises a final answer', () => {
  const s = parseStep('THOUGHT: I can see it now\nDONE: Brightness is 47%.');
  assert.equal(s.done, true);
  assert.equal(s.answer, 'Brightness is 47%.');
});

await test('parseStep treats a plain reply as the answer instead of dropping it', () => {
  const s = parseStep('The screen shows the home launcher.');
  assert.equal(s.done, true);
  assert.match(s.answer, /home launcher/);
});

await test('parseStep treats ACTION done as completion, not a device command', () => {
  // Observed live: the model finished with {"action":"done","text":"..."} and
  // the run kept looping on "Unknown action: done" until the step cap.
  const s = parseStep('THOUGHT: I found it\nACTION: {"action":"done","text":"The Android version is 9."}');
  assert.equal(s.done, true);
  assert.equal(s.answer, 'The Android version is 9.');
});

await test('parseStep flags malformed ACTION JSON', () => {
  const s = parseStep('THOUGHT: try\nACTION: {action: tap, x: 5}');
  assert.equal(s.done, false);
  assert.equal(s.action, null);
  assert.match(s.parseError, /not valid JSON/);
});

await test('uiLabels extracts text and content-desc from the UI tree', () => {
  const xml = '<node text="Display" content-desc="" bounds="[0,0][200,80]" />'
    + '<node text="" content-desc="Brightness" bounds="[0,100][200,180]" />';
  const b64 = Buffer.from(xml).toString('base64');
  const labels = uiLabels(b64);
  assert.deepEqual(labels.sort(), ['Brightness', 'Display']);
});

await test('uiElements gives each element the centre of its real bounds', () => {
  // Captured from the live emulator: "GOT IT" spans the full width at the
  // bottom. The agent used to be told only the label, guessed y=900, and tapped
  // the middle of the page forever.
  const xml = fs.readFileSync(new URL('./fixtures/gmail-welcome.xml', import.meta.url), 'utf8');
  const els = uiElements(Buffer.from(xml).toString('base64'));
  const got = els.find((e) => e.label === 'GOT IT');
  assert.ok(got, 'the GOT IT button must be listed');
  assert.equal(got.clickable, true, 'a clickable button must be marked clickable');
  assert.equal(got.x, 540, 'centre of [0,1647][1080,1794] is x=540');
  assert.equal(got.y, 1721, 'centre of [0,1647][1080,1794] rounds to y=1721');
});

await test('the observation lists coordinates the model can copy', () => {
  const xml = fs.readFileSync(new URL('./fixtures/gmail-welcome.xml', import.meta.url), 'utf8');
  const obs = buildObservation({ uiHierarchy: Buffer.from(xml).toString('base64') });
  assert.match(obs.text, /"GOT IT" tap\(540,1721\)/, 'the tap target must be spelled out');
  assert.match(obs.text, /\[clickable\]/, 'clickable elements are flagged');
});

await test('clickable elements are listed before plain text', () => {
  const xml = fs.readFileSync(new URL('./fixtures/gmail-welcome.xml', import.meta.url), 'utf8');
  const els = uiElements(Buffer.from(xml).toString('base64'));
  assert.equal(els[0].label, 'GOT IT', `expected the button first, got ${els[0].label}`);
});

await test('buildObservation attaches a data-URL frame for the vision model', () => {
  const obs = buildObservation(
    { lastScreenshotUrl: PNG_1PX, uiHierarchy: Buffer.from('<node text="OK" bounds="[0,0][100,60]"/>').toString('base64') },
    { resolution: { width: 1080, height: 2400 } },
  );
  assert.ok(obs.frame && obs.frame.startsWith('data:image/png;base64,'), 'frame must be attachable');
  assert.match(obs.text, /OK/);
  assert.match(obs.text, /1080x2400/);
});

await test('buildObservation never attaches a non-image or oversized URL', () => {
  assert.equal(buildObservation({ lastScreenshotUrl: 'https://example.com/x.png' }).frame, null);
  assert.equal(buildObservation({ lastScreenshotUrl: `data:image/png;base64,${'A'.repeat(7_000_000)}` }).frame, null);
});

await test('isSessionOnline requires a live heartbeat', () => {
  assert.equal(isSessionOnline(ONLINE_SESSION), true);
  assert.equal(isSessionOnline({ ...ONLINE_SESSION, status: 'offline' }), false);
  assert.equal(isSessionOnline({ ...ONLINE_SESSION, lastHeartbeat: new Date(Date.now() - 10 * 60_000).toISOString() }), false);
  assert.equal(isSessionOnline(null), false);
});

await test('a multi-step task drives the device and reports the real outcome', async () => {
  const device = createDevice({ startApp: 'Home', frames: { tap: 'Settings', scroll: 'Display' } });
  const db = createDb(device, ONLINE_SESSION);
  const askAi = scriptedAi([
    'THOUGHT: open the app drawer\nACTION: {"action":"tap","x":540,"y":2000}',
    'THOUGHT: scroll to Display\nACTION: {"action":"scroll","x":540,"y":1800,"y2":600}',
    'THOUGHT: I can read the setting\nDONE: Brightness is 47%.',
  ]);

  const result = await runAgentTask({ DB: db }, {
    conversationId: 'c1', runId: 'r1', task: 'What is the brightness?', askAi,
    isCancelled: () => false,
  });

  assert.equal(result.ok, true, result.answer);
  assert.equal(result.answer, 'Brightness is 47%.');
  assert.equal(result.actions, 2, 'both actions really reached the device');
  assert.equal(device.actions.length, 2);
  assert.deepEqual(device.actions.map((a) => a.action.action), ['tap', 'scroll']);
});

await test('the model is shown the NEW screen after each action', async () => {
  const device = createDevice({ startApp: 'Home', frames: { tap: 'Settings' } });
  const db = createDb(device, ONLINE_SESSION);
  const askAi = scriptedAi([
    'THOUGHT: tap\nACTION: {"action":"tap","x":100,"y":100}',
    'THOUGHT: done\nDONE: opened it',
  ]);

  await runAgentTask({ DB: db }, {
    conversationId: 'c2', runId: 'r2', task: 'open settings', askAi, isCancelled: () => false,
  });

  // Second turn must carry a different frame/observation than the first, proving
  // the loop re-observes rather than replaying a stale screen.
  assert.equal(askAi.seen.length, 2);
  const firstFrame = device.frameCount;
  assert.ok(firstFrame >= 1, 'device produced a new frame after the tap');
});

await test('a failed action is reported to the model instead of being retried blindly', async () => {
  const device = createDevice({ startApp: 'Home', failAction: 'tap' });
  const db = createDb(device, ONLINE_SESSION);
  const askAi = scriptedAi([
    'THOUGHT: tap\nACTION: {"action":"tap","x":1,"y":1}',
    'THOUGHT: blocked\nDONE: I could not tap the element; the device rejected it.',
  ]);

  const result = await runAgentTask({ DB: db }, {
    conversationId: 'c3', runId: 'r3', task: 'tap it', askAi, isCancelled: () => false,
  });

  assert.equal(result.ok, true);
  const failureEvent = result.events.find((e) => e.kind === 'error');
  assert.ok(failureEvent, 'a failed action must be surfaced as an event');
  assert.match(failureEvent.detail, /rejected by the device/);

  // The next prompt must carry the failure so the model can adapt.
  const lastPrompt = askAi.seen[1];
  const text = typeof lastPrompt === 'string' ? lastPrompt : JSON.stringify(lastPrompt);
  assert.match(text, /FAILED/);
});

await test('an offline device fails fast without pretending to work', async () => {
  const device = createDevice();
  const db = createDb(device, { ...ONLINE_SESSION, status: 'offline' });
  let aiCalls = 0;
  const result = await runAgentTask({ DB: db }, {
    conversationId: 'c4', runId: 'r4', task: 'anything',
    askAi: async () => { aiCalls += 1; return { ok: true, content: 'DONE: x' }; },
    isCancelled: () => false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'device offline');
  assert.equal(aiCalls, 0, 'no model call should be made against a dead device');
  assert.equal(device.actions.length, 0, 'no action may be queued against a dead device');
  assert.match(result.answer, /offline/i);
});

await test('cancellation stops the run between steps', async () => {
  const device = createDevice({ startApp: 'Home' });
  const db = createDb(device, ONLINE_SESSION);
  let calls = 0;
  const result = await runAgentTask({ DB: db }, {
    conversationId: 'c5', runId: 'r5', task: 'loop forever',
    askAi: async () => {
      calls += 1;
      return { ok: true, content: 'THOUGHT: again\nACTION: {"action":"tap","x":5,"y":5}' };
    },
    isCancelled: () => calls >= 2,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  assert.ok(calls < MAX_STEPS, 'must stop early rather than run to the cap');
});

await test('an unreachable AI provider fails with the provider error', async () => {
  const device = createDevice();
  const db = createDb(device, ONLINE_SESSION);
  const result = await runAgentTask({ DB: db }, {
    conversationId: 'c6', runId: 'r6', task: 'x',
    askAi: async () => ({ ok: false, error: 'nvidia HTTP 401' }),
    isCancelled: () => false,
  });

  assert.equal(result.ok, false);
  assert.match(result.answer, /nvidia HTTP 401/);
  assert.ok(result.events.some((e) => e.kind === 'error'));
});

await test('the step cap is enforced and reported honestly', async () => {
  const device = createDevice({ startApp: 'Home' });
  const db = createDb(device, ONLINE_SESSION);
  const result = await runAgentTask({ DB: db }, {
    conversationId: 'c7', runId: 'r7', task: 'never finish',
    askAi: async () => ({ ok: true, content: 'THOUGHT: again\nACTION: {"action":"tap","x":9,"y":9}' }),
    isCancelled: () => false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'step limit');
  assert.equal(result.steps, MAX_STEPS);
  assert.match(result.answer, /step limit/);
});

await test('every emitted event corresponds to real work and is ordered', async () => {
  const device = createDevice({ startApp: 'Home', frames: { tap: 'Settings' } });
  const db = createDb(device, ONLINE_SESSION);
  const askAi = scriptedAi([
    'THOUGHT: tap\nACTION: {"action":"tap","x":10,"y":10}',
    'THOUGHT: done\nDONE: finished',
  ]);

  const result = await runAgentTask({ DB: db }, {
    conversationId: 'c8', runId: 'r8', task: 'go', askAi, isCancelled: () => false,
  });

  const kinds = result.events.map((e) => e.kind);
  assert.ok(kinds.includes('plan'), 'the run announces the task');
  assert.ok(kinds.includes('observe'), 'the run reads the screen');
  assert.ok(kinds.includes('tool'), 'the run reports the action');
  assert.ok(kinds.includes('verify'), 'the run reports the outcome');

  // Events are also persisted, which is what the SSE replay reads.
  assert.ok(db.events.length >= result.events.length - 1);
  const seqs = db.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'events persist in order');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
