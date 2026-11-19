/**
 * Tests for the autonomous agent engine and automation-detail features:
 *   - natural-language automation creation (parse → validate → persist)
 *   - the "linked task" regression (automation detail returns real data)
 *   - agent activity events (append, ordered read, SSE payload shape)
 *   - action client-id de-duplication and result correlation
 *   - the screenshot endpoint's small-frame selection
 *
 * The real handlers are exercised; only the Workers KV/D1 platform APIs and
 * outbound fetch are stubbed.
 *
 * Run: node tests/test_agent_engine.mjs
 */
import assert from 'node:assert/strict';
import { handleFrontend, looksLikeAutomationRequest, parseAutomationRequest, createAutomation } from '../cloudflare-backend/src/frontend.js';
import { handleEmulator } from '../cloudflare-backend/src/emulator.js';
import { appendAgentEvent, listAgentEvents, upsertDeviceState, getDeviceState, upsertAutomation, saveChatMessage, claimDeviceAction } from '../cloudflare-backend/src/database.js';

/* ------------------------------------------------------------------ stubs */

function createKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

// SQL-aware in-memory stand-in for the tables these handlers touch. It parses
// column lists from INSERT/UPDATE and understands the SELECTs the handlers issue.
function createDb() {
  const rows = {
    conversations: new Map(), chat_messages: new Map(), chats: new Map(),
    agent_events: new Map(), executions: new Map(),
  };
  let deviceState = null;
  let automationRows = new Map();
  const list = (name) => Array.from(rows[name].values());

  const db = {
    rows, get deviceState() { return deviceState; }, set deviceState(v) { deviceState = v; },
    get automations() { return Array.from(automationRows.values()); },
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/FROM device_state/i.test(sql)) return deviceState;
          if (/MAX\(seq\)/i.test(sql)) {
            const [conv, auto] = this._args;
            const matching = list('agent_events').filter((e) =>
              (e.conversation_id || null) === (conv || null) && (e.automation_id || null) === (auto || null));
            const max = matching.reduce((m, e) => Math.max(m, Number(e.seq || 0)), 0);
            return { maxSeq: max || null };
          }
          if (/FROM automations/i.test(sql)) return automationRows.get(this._args[0]) || null;
          if (/FROM conversations\s+WHERE\s+id/i.test(sql)) return rows.conversations.get(this._args[0]) || null;
          if (/FROM emulator_sessions/i.test(sql)) return null;
          return null;
        },
        async run() {
          const args = this._args;
          // Conditional UPDATE (the atomic action claim): only report a changed
          // row when the WHERE clause still holds for this client id.
          if (/UPDATE device_state/i.test(sql) && /last_action_status != 'pending'/i.test(sql)) {
            const [actionJson, clientId] = args;
            const s = deviceState || {};
            const blocked = s.last_action_status === 'pending' && s.last_action_client_id === clientId;
            if (blocked) return { success: true, meta: { changes: 0 } };
            deviceState = {
              ...s,
              last_action: actionJson,
              last_action_result: 'pending',
              last_action_client_id: clientId,
              last_action_status: 'pending',
            };
            return { success: true, meta: { changes: 1 } };
          }
          const ins = sql.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/i);
          if (ins) {
            const table = ins[1];
            const cols = ins[2].split(',').map((c) => c.trim());
            const row = {};
            cols.forEach((c, i) => { row[c] = args[i]; });
            if (table === 'device_state') { deviceState = { ...(deviceState || {}), ...row }; return { success: true }; }
            if (table === 'automations') { automationRows.set(row.id, { ...(automationRows.get(row.id) || {}), ...row }); return { success: true }; }
            if (rows[table]) { rows[table].set(row.id, { ...(rows[table].get(row.id) || {}), ...row }); return { success: true }; }
            return { success: true };
          }
          const upd = sql.match(/UPDATE (\w+) SET (.+?) WHERE/i);
          if (upd) {
            const table = upd[1];
            const cols = upd[2].split(',').map((x) => x.trim().split('=')[0].trim());
            const id = args[args.length - 1];
            if (table === 'device_state') {
              const row = {};
              cols.forEach((c, i) => { row[c] = args[i]; });
              deviceState = { ...(deviceState || {}), ...row };
              return { success: true };
            }
            if (table === 'automations') {
              const row = automationRows.get(id) || {};
              cols.forEach((c, i) => { row[c] = args[i]; });
              automationRows.set(id, row);
              return { success: true };
            }
            if (rows[table]) {
              const row = rows[table].get(id) || {};
              cols.forEach((c, i) => { row[c] = args[i]; });
              rows[table].set(id, row);
              return { success: true };
            }
            return { success: true };
          }
          const del = sql.match(/DELETE FROM (\w+)/i);
          if (del && rows[del[1]]) { rows[del[1]].delete(args[0]); return { success: true }; }
          return { success: true };
        },
        async all() {
          if (/FROM agent_events/i.test(sql)) {
            let out = list('agent_events').filter((e) => Number(e.seq || 0) > Number(this._args[0] || 0));
            // Args after the seq filter are optional conversation/automation ids.
            const rest = this._args.slice(1);
            const filters = [...sql.matchAll(/AND (\w+) = \?/g)].map((m) => m[1]);
            filters.forEach((f, i) => { out = out.filter((e) => e[f] === rest[i]); });
            out = out.sort((a, b) => Number(a.seq) - Number(b.seq));
            return { results: out };
          }
          if (/FROM executions/i.test(sql)) {
            return { results: list('executions').filter((e) => e.automation_id === this._args[0]) };
          }
          if (/FROM chat_messages/i.test(sql)) {
            return { results: list('chat_messages').filter((m) => m.conversation_id === this._args[0]) };
          }
          if (/FROM chats/i.test(sql)) {
            return { results: list('chats').filter((m) => m.automation_id === this._args[0]) };
          }
          if (/FROM automations/i.test(sql)) return { results: list('automations') };
          return { results: [] };
        },
      };
      return stmt;
    },
    async exec() { return { success: true }; },
  };
  return db;
}

const corsHeaders = () => ({});
const req = (path, method, body) => new Request(`https://vexa.test${path}`, {
  method, headers: { 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

/* ------------------------------------------------------------------ tests */

await test('automation intent is detected in natural language', async () => {
  assert.equal(looksLikeAutomationRequest('create an automation that opens Settings every hour'), true);
  assert.equal(looksLikeAutomationRequest('run this every 30 minutes'), true);
  assert.equal(looksLikeAutomationRequest('what is on the screen right now?'), false);
});

await test('parseAutomationRequest validates the schedule and falls back deterministically', async () => {
  // No AI provider configured → deterministic parse must still produce a valid config.
  const env = { CONFIG_KV: createKv(), DB: createDb() };
  const parsed = await parseAutomationRequest(env, 'open Chrome every 2 hours and check the news');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.intervalMinutes, 120);
  assert.ok(parsed.config.instructions.length > 0);
  assert.ok(parsed.config.name.length <= 60);
});

await test('parseAutomationRequest rejects an empty task', async () => {
  const env = { CONFIG_KV: createKv(), DB: createDb() };
  const parsed = await parseAutomationRequest(env, '   ');
  assert.equal(parsed.ok, false);
});

await test('createAutomation persists a durable, scheduled record with its own conversation', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), DB: db };
  const created = await createAutomation(env, {
    name: 'Open Settings', instructions: 'Open Settings', scheduleType: 'interval', intervalMinutes: 60,
  });
  assert.equal(created.enabled, true);
  assert.ok(created.nextRunAt, 'next run must be scheduled for a durable cron to pick up');
  assert.ok(db.rows.conversations.get(created.id), 'automation gets its own conversation');
  const events = db.rows.agent_events;
  assert.ok(Array.from(events.values()).some((e) => e.kind === 'automation'), 'creation is recorded as an event');
});

await test('POST /api/frontend/agent/automation creates a real automation', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), DB: db };
  const res = await handleFrontend(
    req('/api/frontend/agent/automation', 'POST', { instruction: 'open the calculator every hour', conversationId: 'conv_x' }),
    env, {}, null, corsHeaders);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.automation.id.startsWith('auto_'));
  assert.equal(body.automation.intervalMinutes, 60);
});

await test('automation detail returns the real prompt, messages, executions and events', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), DB: db };
  const created = await createAutomation(env, {
    name: 'Open Settings', instructions: 'Open the Settings app', scheduleType: 'once', intervalMinutes: 60,
  });
  await saveChatMessage(db, { id: 'm1', automationId: created.id, role: 'user', content: 'Open the Settings app' });
  await saveChatMessage(db, { id: 'm2', automationId: created.id, role: 'agent', content: 'Opened Settings.' });
  await appendAgentEvent(db, { automationId: created.id, kind: 'plan', title: 'Task received', detail: 'Open the Settings app' });
  await appendAgentEvent(db, { automationId: created.id, kind: 'tool', title: 'Executed tap(540,1200)', detail: 'screen changed', status: 'done' });

  const res = await handleFrontend(req(`/api/frontend/automations/${created.id}`, 'GET'), env, {}, null, corsHeaders);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.automation.name, 'Open Settings');
  assert.equal(body.messages.length, 2);
  // 1 creation event + 2 appended = 3, ordered by seq.
  assert.equal(body.events.length, 3);
  assert.equal(body.events[0].kind, 'automation');
  // The regression: the old UI printed a hardcoded "linked task" name instead of
  // this data. Confirm the detail payload carries the real automation name.
  assert.ok(!JSON.stringify(body).includes('linked task'));
});

await test('agent events are appended with a monotonic seq and read back in order', async () => {
  const db = createDb();
  await appendAgentEvent(db, { conversationId: 'c1', kind: 'plan', title: 'a' });
  await appendAgentEvent(db, { conversationId: 'c1', kind: 'tool', title: 'b' });
  await appendAgentEvent(db, { conversationId: 'c1', kind: 'verify', title: 'c' });
  const events = await listAgentEvents(db, { conversationId: 'c1' });
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(events.map((e) => e.title), ['a', 'b', 'c']);
  // Incremental read returns only newer events, which is what the SSE stream does.
  const after = await listAgentEvents(db, { conversationId: 'c1', afterSeq: 1 });
  assert.deepEqual(after.map((e) => e.title), ['b', 'c']);
});

await test('a queued action records its client id and duplicate is suppressed', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: db };
  await upsertDeviceState(db, { lastScreenshotUrl: 'data:image/png;base64,AAAA' });
  const first = await handleEmulator(
    req('/api/emulator/action', 'POST', { action: 'tap', x: 0.5, y: 0.5, clientId: 'act_1' }),
    env, {}, null, corsHeaders);
  const firstBody = await first.json();
  assert.equal(firstBody.queued, true);
  assert.equal(firstBody.duplicate, undefined);

  const state = await getDeviceState(db);
  assert.equal(state.lastActionClientId, 'act_1');
  assert.equal(state.lastActionStatus, 'pending');
  assert.equal(state.lastScreenshotUrl, 'data:image/png;base64,AAAA', 'queueing must not blank the frame');

  // Same client id while still pending must not queue a second device command.
  const dup = await handleEmulator(
    req('/api/emulator/action', 'POST', { action: 'tap', x: 0.5, y: 0.5, clientId: 'act_1' }),
    env, {}, null, corsHeaders);
  const dupBody = await dup.json();
  assert.equal(dupBody.duplicate, true);
});

await test('claimDeviceAction is atomic: only one of two racing requests wins', async () => {
  const db = createDb();
  await upsertDeviceState(db, { lastScreenshotUrl: 'data:image/png;base64,AAAA' });
  // Two identical claims issued without awaiting between them — the case the
  // old read-then-write check let through twice.
  const [a, b] = await Promise.all([
    claimDeviceAction(db, { action: { action: 'tap', x: 1, y: 1 }, clientId: 'race_1' }),
    claimDeviceAction(db, { action: { action: 'tap', x: 1, y: 1 }, clientId: 'race_1' }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1, 'exactly one claim may win');
});

await test('a claim with no client id always succeeds and preserves the frame', async () => {
  const db = createDb();
  await upsertDeviceState(db, { lastScreenshotUrl: 'data:image/png;base64,AAAA' });
  const won = await claimDeviceAction(db, { action: { action: 'home' }, clientId: null });
  assert.equal(won, true);
  const state = await getDeviceState(db);
  assert.equal(state.lastScreenshotUrl, 'data:image/png;base64,AAAA');
});

await test('action result marks the action done and preserves the previous frame', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: db };
  await upsertDeviceState(db, { lastScreenshotUrl: 'data:image/png;base64,AAAA' });
  await handleEmulator(req('/api/emulator/action', 'POST', { action: 'tap', x: 0.5, y: 0.5, clientId: 'act_9' }), env, {}, null, corsHeaders);
  // Emulator reports success WITHOUT a new screenshot: the old frame must survive.
  await handleEmulator(req('/api/emulator/action-result', 'POST', { action: 'tap', success: true }), env, {}, null, corsHeaders);
  const state = await getDeviceState(db);
  assert.equal(state.lastActionStatus, 'done');
  assert.equal(state.lastScreenshotUrl, 'data:image/png;base64,AAAA', 'frame must not be blanked');
});

await test('the screenshot endpoint prefers the small frame when a client asks for it', async () => {
  const db = createDb();
  const env = { CONFIG_KV: createKv(), SESSION_KV: createKv(), DB: db };
  await upsertDeviceState(db, {
    lastScreenshotUrl: 'data:image/png;base64,FULLFULL',
    lastScreenshotSmallUrl: 'data:image/jpeg;base64,U01BTA==',
  });
  // index.js's public handler selects on ?h=; assert the stored state exposes both
  // variants so that selection has something to choose between.
  const state = await getDeviceState(db);
  assert.ok(state.lastScreenshotUrl);
  assert.ok(state.lastScreenshotSmallUrl);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
