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
  // Row-store tables (conversations, chats) keyed by id, so the real
  // ON CONFLICT / SELECT / DELETE SQL the handlers use can run unchanged.
  const rows = { conversations: new Map(), chats: new Map(), chat_messages: new Map() };
  const listTable = (name) => Array.from(rows[name].values());
  return {
    tables,
    rows,
    prepare(sql) {
      const q = { sql, _args: [] };
      return {
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/FROM device_state/i.test(sql)) return tables.device_state;
          if (/FROM emulator_sessions/i.test(sql)) return tables.emulator_sessions;
          if (/FROM conversations\s+WHERE\s+id/i.test(sql)) return rows.conversations.get(this._args[0]) || null;
          return null;
        },
        async run() {
          const args = this._args;
          const ins = sql.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/i);
          if (ins) {
            const row = {};
            ins[2].split(',').map((c) => c.trim()).forEach((c, i) => { row[c] = args[i]; });
            if (rows[ins[1]]) {
              const existing = rows[ins[1]].get(row.id) || {};
              rows[ins[1]].set(row.id, { ...existing, ...row });
            } else {
              tables[ins[1]] = row;
            }
            return { success: true };
          }
          const upd = sql.match(/UPDATE (\w+) SET (.+?) WHERE/i);
          if (upd) {
            const cols = upd[2].split(',').map((x) => x.trim().split('=')[0].trim());
            const target = rows[upd[1]];
            if (target && this._args.length) {
              const id = this._args[this._args.length - 1];
              const row = target.get(id) || {};
              cols.forEach((c, i) => { row[c] = args[i]; });
              target.set(id, row);
            } else {
              const row = tables[upd[1]] || {};
              cols.forEach((c, i) => { row[c] = args[i]; });
              tables[upd[1]] = row;
            }
            return { success: true };
          }
          const del = sql.match(/DELETE FROM (\w+)/i);
          if (del) {
            if (rows[del[1]]) { rows[del[1]].delete(this._args[0]); return { success: true }; }
            tables[del[1]] = null;
            return { success: true };
          }
          return { success: true };
        },
        async all() {
          if (/FROM conversations/i.test(sql)) {
            const out = listTable('conversations')
              .map((c) => ({ ...c, message_count: listTable('chat_messages').filter((m) => m.conversation_id === c.id).length }))
              .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : (a.id < b.id ? 1 : -1)));
            return { results: out };
          }
          if (/FROM chat_messages/i.test(sql)) {
            return { results: listTable('chat_messages').filter((m) => m.conversation_id === this._args[0]) };
          }
          if (/FROM chats/i.test(sql)) {
            return { results: listTable('chats').filter((m) => m.automation_id === this._args[0]) };
          }
          return { results: [] };
        },
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

await test('chat attaches the live screenshot so the model can actually see the screen', async () => {
  // Regression: the chat handler claimed a screenshot was attached but sent
  // text only, so the vision model invented the screen contents.
  const realFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return Response.json({ choices: [{ message: { content: 'I can see the Battery settings page.' } }] });
  };
  try {
    const db = createDb();
    db.tables.device_state = {
      id: 'current',
      last_screenshot_url: 'data:image/png;base64,QUJD',
      ui_hierarchy: Buffer.from('<node text="Battery" bounds="[0,0][100,100]"/>').toString('base64'),
    };
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ provider: 'nvidia', apiKeyEncrypted: 'nvapi-x' }) }),
      SESSION_KV: createKv({
        'emulator:default': JSON.stringify({ id: 'default', status: 'online', lastHeartbeat: new Date().toISOString() }),
      }),
      DB: db,
    };
    const res = await handleFrontend(
      req('/api/frontend/chat', 'POST', { message: 'what is on screen?' }),
      env, {}, null, corsHeaders,
    );
    await res.json();
    const userMsg = sentBody.messages[sentBody.messages.length - 1];
    assert.ok(Array.isArray(userMsg.content), 'the user turn must be multimodal when a frame exists');
    const image = userMsg.content.find((c) => c.type === 'image_url');
    assert.ok(image, 'the live frame must be attached as an image_url');
    assert.equal(image.image_url.url, 'data:image/png;base64,QUJD');
    assert.match(sentBody.messages[0].content, /Battery/, 'the UI tree text must reach the model');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('chat omits the image when the device is offline', async () => {
  const realFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return Response.json({ choices: [{ message: { content: 'The device is offline.' } }] });
  };
  try {
    const db = createDb();
    db.tables.device_state = { id: 'current', last_screenshot_url: 'data:image/png;base64,QUJD' };
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ provider: 'nvidia', apiKeyEncrypted: 'nvapi-x' }) }),
      SESSION_KV: createKv(), DB: db,
    };
    await handleFrontend(
      req('/api/frontend/chat', 'POST', { message: 'what is on screen?' }),
      env, {}, null, corsHeaders,
    );
    const userMsg = sentBody.messages[sentBody.messages.length - 1];
    assert.equal(typeof userMsg.content, 'string', 'an offline device must not attach a stale frame');
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

await test('a queued action is returned to the emulator by pending-action', async () => {
  // Regression: pending-action read state.last_action while getDeviceState
  // returns camelCase, so the emulator was handed null for every action and
  // the phone never moved.
  const db = createDb();
  const env = { DB: db, SESSION_KV: createKv(), CONFIG_KV: createKv() };

  await handleEmulator(
    req('/api/emulator/action', 'POST', { action: 'swipe', x: 540, y: 1600, x2: 540, y2: 400, ms: 250 }),
    env, {}, null, corsHeaders,
  );

  const res = await handleEmulator(req('/api/emulator/pending-action', 'GET'), env, {}, null, corsHeaders);
  const data = await res.json();
  assert.ok(data.action, 'the emulator must receive the queued action');
  assert.equal(data.action.action, 'swipe');
  assert.equal(data.action.y2, 400);
});

await test('pending-action returns null once the result has been reported', async () => {
  const db = createDb();
  const env = { DB: db, SESSION_KV: createKv(), CONFIG_KV: createKv() };
  await handleEmulator(req('/api/emulator/action', 'POST', { action: 'home' }), env, {}, null, corsHeaders);
  await handleEmulator(
    req('/api/emulator/action-result', 'POST', { action: 'home', success: true }),
    env, {}, null, corsHeaders,
  );
  const res = await handleEmulator(req('/api/emulator/pending-action', 'GET'), env, {}, null, corsHeaders);
  assert.equal((await res.json()).action, null);
});

await test('action-result without a screenshot preserves the previous frame', async () => {
  const db = createDb();
  const env = { DB: db, SESSION_KV: createKv(), CONFIG_KV: createKv() };
  await handleEmulator(
    req('/api/emulator/screenshot', 'POST', { screenshotBase64: 'KEEPME', uiHierarchy: '<hierarchy/>' }),
    env, {}, null, corsHeaders,
  );
  await handleEmulator(req('/api/emulator/action', 'POST', { action: 'tap', x: 1, y: 2 }), env, {}, null, corsHeaders);
  await handleEmulator(
    req('/api/emulator/action-result', 'POST', { action: 'tap', success: true }),
    env, {}, null, corsHeaders,
  );
  const state = await (await handleEmulator(req('/api/public/device-state', 'GET'), env, {}, null, corsHeaders)).json();
  assert.match(state.screenshotUrl, /KEEPME$/, 'the frame must survive a screenshot-less result');
  assert.equal(state.uiHierarchy, '<hierarchy/>');
});

await test('public device-state exposes camelCase fields the agent reads', async () => {
  // Regression: this handler returned snake_case keys that were always
  // undefined, so the agent runner received a null UI tree.
  const db = createDb();
  const env = { DB: db, SESSION_KV: createKv(), CONFIG_KV: createKv() };
  await handleEmulator(
    req('/api/emulator/screenshot', 'POST', { screenshotBase64: 'AAAA', uiHierarchy: '<hierarchy><node text="Calculator"/></hierarchy>' }),
    env, {}, null, corsHeaders,
  );
  const data = await (await handleEmulator(req('/api/public/device-state', 'GET'), env, {}, null, corsHeaders)).json();
  assert.ok(data.screenshotUrl, 'screenshotUrl must be populated');
  assert.match(data.uiHierarchy, /Calculator/);
  assert.ok(data.updatedAt, 'updatedAt must be populated');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/* ---------------------------------------------------------- conversations */

await test('a chat message creates a conversation with a derived title', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'Sure.' } }] });
  try {
    const db = createDb();
    const env = {
      CONFIG_KV: createKv({ settings_config: JSON.stringify({ provider: 'nvidia', apiKeyEncrypted: 'nvapi-x' }) }),
      SESSION_KV: createKv(), DB: db,
    };
    const res = await handleFrontend(
      req('/api/frontend/chat', 'POST', { message: 'Open the Calculator app and multiply 127 by 83' }),
      env, {}, null, corsHeaders,
    );
    const data = await res.json();
    assert.ok(data.conversationId, 'a conversation id is returned');
    assert.match(data.title, /Open the Calculator/);
    assert.equal(db.rows.conversations.size, 1, 'the conversation is persisted');
    assert.equal(db.rows.chat_messages.size, 2, 'both the user and agent messages are stored');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('conversations survive and list newest first', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: db };
  await handleFrontend(req('/api/frontend/conversations', 'POST', { title: 'First chat' }), env, {}, null, corsHeaders);
  await new Promise((r) => setTimeout(r, 20));
  await handleFrontend(req('/api/frontend/conversations', 'POST', { title: 'Second chat' }), env, {}, null, corsHeaders);

  const res = await handleFrontend(req('/api/frontend/conversations', 'GET'), env, {}, null, corsHeaders);
  const data = await res.json();
  assert.equal(data.conversations.length, 2, 'both chats are listed after a reload');
  assert.equal(data.conversations[0].title, 'Second chat', 'newest chat is first');
});

await test('a conversation can be renamed and deleted', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: db };
  const created = await (await handleFrontend(req('/api/frontend/conversations', 'POST', { title: 'Old' }), env, {}, null, corsHeaders)).json();
  const id = created.conversation.id;

  const renamed = await (await handleFrontend(req(`/api/frontend/conversations/${id}`, 'PATCH', { title: 'Renamed' }), env, {}, null, corsHeaders)).json();
  assert.equal(renamed.conversation.title, 'Renamed');

  await handleFrontend(req(`/api/frontend/conversations/${id}`, 'DELETE'), env, {}, null, corsHeaders);
  const list = await (await handleFrontend(req('/api/frontend/conversations', 'GET'), env, {}, null, corsHeaders)).json();
  assert.equal(list.conversations.length, 0, 'the deleted chat is gone');
});

console.log(`\n${passed} passed, ${failed} failed`);
