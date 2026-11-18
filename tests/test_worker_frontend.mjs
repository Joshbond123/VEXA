/**
 * Regression tests for the VEXA device-control endpoints in the Cloudflare Worker.
 *
 * These cover the bugs that left the AI agent unable to see or drive the phone:
 *   - /api/emulator/action used to null the stored screenshot and UI tree, so
 *     the live preview went blank on every tap.
 *   - /api/frontend/emulator-status reported only a heartbeat, so the UI could
 *     not tell a live stream from a stale frame.
 *   - There was no endpoint to start or stop the emulator workflow at all.
 *
 * The real `handleFrontend` and `handleEmulator` handlers are exercised; only
 * the Workers KV/D1 platform APIs and outbound fetch are stubbed.
 *
 * Run: node tests/test_worker_frontend.mjs
 */
import assert from 'node:assert/strict';
import { handleFrontend } from '../cloudflare-backend/src/frontend.js';
import { handleEmulator } from '../cloudflare-backend/src/emulator.js';
import { upsertDeviceState, upsertEmulatorSession } from '../cloudflare-backend/src/database.js';

/* ------------------------------------------------------------------ stubs */

// Minimal in-memory stand-in for a Workers KV namespace.
function createKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

// Small SQL-aware stand-in for the two D1 tables these handlers touch. It
// parses the column lists out of INSERT/UPDATE so the handlers' real SQL runs
// unchanged; only the storage engine is replaced.
function createDb() {
  const tables = { device_state: null, emulator_sessions: null };
  return {
    tables,
    prepare(sql) {
      return {
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/FROM device_state/i.test(sql)) return tables.device_state;
          if (/FROM emulator_sessions/i.test(sql)) return tables.emulator_sessions;
          return null;
        },
        async run() {
          const args = this._args;
          const ins = sql.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/i);
          if (ins) {
            const row = {};
            ins[2].split(',').map((c) => c.trim()).forEach((c, i) => { row[c] = args[i]; });
            tables[ins[1]] = row;
            return { success: true };
          }
          const upd = sql.match(/UPDATE (\w+) SET (.+?) WHERE/i);
          if (upd) {
            const cols = upd[2].split(',').map((s) => s.trim().split('=')[0].trim());
            const row = tables[upd[1]] || {};
            cols.forEach((c, i) => { row[c] = args[i]; });
            tables[upd[1]] = row;
            return { success: true };
          }
          if (/DELETE FROM device_state/i.test(sql)) { tables.device_state = null; return { success: true }; }
          if (/DELETE FROM emulator_sessions/i.test(sql)) { tables.emulator_sessions = null; return { success: true }; }
          return { success: true };
        },
        async all() { return { results: [] }; },
      };
    },
  };
}

const corsHeaders = () => ({});
const req = (path, method, body) => new Request(`https://vexa.test${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ------------------------------------------------------------------ tests */

await test('emulator status reports frame freshness, not just a heartbeat', async () => {
  const now = new Date().toISOString();
  const session = {
    id: 'default', status: 'online', gatewayUrl: 'https://gw', deviceModel: 'Pixel 2',
    androidVersion: '9', resolution: '1080x1920', lastHeartbeat: now,
  };
  const db = createDb();
  db.tables.emulator_sessions = { id: "default", gateway_url: session.gatewayUrl, status: session.status, device_model: session.deviceModel, android_version: session.androidVersion, resolution: session.resolution, last_heartbeat: session.lastHeartbeat, updated_at: now };
  // The stored session and device row are what the handler reads back.
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: db };
  await upsertEmulatorSession(db, session);
  await upsertDeviceState(db, { lastScreenshotUrl: 'data:image/png;base64,AAAA' });

  const res = await handleFrontend(req('/api/frontend/emulator-status', 'GET'), env, {}, null, corsHeaders);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.online, true, 'a fresh heartbeat means online');
  assert.equal(data.hasFrame, true, 'a stored screenshot means a frame exists');
  assert.equal(data.frameFresh, true, 'a just-updated frame is fresh');
  assert.equal(data.screenshotUrl, 'https://vexa-ai-agent.replyraven001.workers.dev/api/public/screenshot');
});

await test('emulator status is offline with no session and never throws', async () => {
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: createDb() };
  const res = await handleFrontend(req('/api/frontend/emulator-status', 'GET'), env, {}, null, corsHeaders);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.online, false);
  assert.equal(data.registered, false);
});

await test('emulator start dispatches the workflow and returns 204 handling', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(null, { status: 204 });
  };
  try {
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ githubPatEncrypted: 'ghp_test' }) }),
      SESSION_KV: createKv(), DB: createDb(),
    };
    const res = await handleFrontend(req('/api/frontend/emulator/start', 'POST', {}), env, {}, null, corsHeaders);
    const data = await res.json();
    assert.equal(data.ok, true, 'a 204 from GitHub is a successful dispatch');
    assert.ok(calls[0].url.includes('/actions/workflows/android-emulator.yml/dispatches'),
      'must dispatch the android-emulator workflow');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer ghp_test');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.ref, 'vexa', 'must dispatch on the vexa branch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('emulator start reports a missing PAT instead of silently doing nothing', async () => {
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: createDb() };
  const res = await handleFrontend(req('/api/frontend/emulator/start', 'POST', {}), env, {}, null, corsHeaders);
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.match(data.error, /PAT/i);
});

await test('emulator stop cancels in-flight runs and clears the session', async () => {
  const cancelled = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/runs?status=in_progress')) {
      return Response.json({ workflow_runs: [{ id: 111 }, { id: 222 }] });
    }
    if (u.includes('/cancel')) { cancelled.push(u); return new Response(null, { status: 202 }); }
    return new Response(null, { status: 404 });
  };
  try {
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ githubPatEncrypted: 'ghp_test' }) }),
      SESSION_KV: createKv({ 'emulator:default': JSON.stringify({ id: 'default', status: 'online' }) }),
      DB: createDb(),
    };
    const res = await handleFrontend(req('/api/frontend/emulator/stop', 'POST', {}), env, {}, null, corsHeaders);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.cancelled, 2, 'both in-flight runs must be cancelled');
    assert.equal(env.SESSION_KV.store.has('emulator:default'), false, 'session KV entry must be cleared');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('queueing a device action preserves the stored screenshot', async () => {
  // Regression: this handler used to write lastScreenshotUrl: null, blanking the
  // live preview the moment the agent took a step.
  const db = createDb();
  await upsertDeviceState(db, {
    lastScreenshotUrl: 'data:image/png;base64,FRAME',
    uiHierarchy: 'package=com.android.settings',
  });
  const env = { DB: db, SESSION_KV: createKv(), CONFIG_KV: createKv() };

  const res = await handleEmulator(
    req('/api/emulator/action', 'POST', { action: 'tap', x: 100, y: 200 }),
    env, {}, null, corsHeaders,
  );
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.queued, true);

  const state = db.tables.device_state;
  assert.equal(state.last_screenshot_url, 'data:image/png;base64,FRAME',
    'the live frame must survive an in-flight action');
  assert.equal(state.last_action_result, 'pending');
  assert.ok(state.last_action.includes('"tap"'));
});

await test('device action rejects unknown actions', async () => {
  const env = { DB: createDb(), SESSION_KV: createKv(), CONFIG_KV: createKv() };
  const res = await handleEmulator(
    req('/api/emulator/action', 'POST', { action: 'selfdestruct' }),
    env, {}, null, corsHeaders,
  );
  assert.equal(res.status, 400);
});

await test('chat replies with a real AI response and reports device state', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: 'I can open apps and navigate the phone.' } }],
  });
  try {
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ provider: 'nvidia', apiKeyEncrypted: 'nvapi-x' }) }),
      SESSION_KV: createKv(), DB: createDb(),
    };
    const res = await handleFrontend(
      req('/api/frontend/chat', 'POST', { message: 'what can you do?' }),
      env, {}, null, corsHeaders,
    );
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.reply, 'I can open apps and navigate the phone.');
    assert.equal(data.deviceOnline, false, 'no session means the device is offline');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('chat fails clearly when no API key is configured', async () => {
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: createDb() };
  const res = await handleFrontend(
    req('/api/frontend/chat', 'POST', { message: 'hi' }),
    env, {}, null, corsHeaders,
  );
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.error, /API key/i);
});

await test('a device action in a chat reply is queued when the device is online', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: 'Opening Settings now.\nACTION: {"action":"launch","app":"com.android.settings"}' } }],
  });
  try {
    const db = createDb();
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ provider: 'nvidia', apiKeyEncrypted: 'nvapi-x' }) }),
      SESSION_KV: createKv({
        'emulator:default': JSON.stringify({ id: 'default', status: 'online', lastHeartbeat: new Date().toISOString() }),
      }),
      DB: db,
    };
    const res = await handleFrontend(
      req('/api/frontend/chat', 'POST', { message: 'open settings' }),
      env, {}, null, corsHeaders,
    );
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.queuedAction, 'the action from the reply must be queued');
    assert.equal(data.queuedAction.action, 'launch');
    assert.ok(!data.reply.includes('ACTION:'), 'the raw action line must be stripped from the reply');
    assert.equal(db.tables.device_state.last_action_result, 'pending');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('reasoning models are accepted when content is empty', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: null, reasoning_content: 'Here is the answer.' } }],
  });
  try {
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ provider: 'nvidia', apiKeyEncrypted: 'nvapi-x' }) }),
      SESSION_KV: createKv(), DB: createDb(),
    };
    const res = await handleFrontend(
      req('/api/frontend/chat', 'POST', { message: 'hi' }),
      env, {}, null, corsHeaders,
    );
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.reply, 'Here is the answer.');
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
