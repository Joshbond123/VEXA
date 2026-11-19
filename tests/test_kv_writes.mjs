/**
 * Regression tests for the KV write-reduction layer and the emulator heartbeat.
 *
 * Context: the free Workers plan allows 1,000 KV writes/day. The emulator beat
 * every 30s and wrote `emulator:default` each time (2,880 writes/day), so the
 * cap was hit within hours and every later put() returned 429. These tests pin
 * the three behaviours that keep us under the cap: unchanged values are not
 * rewritten, writes are throttled per key, and a 429 never fails a request.
 *
 * Run: node tests/test_kv_writes.mjs
 */
import assert from 'node:assert/strict';
import { kvPutJson, kvGetJson, kvStats, resetKvStats } from '../cloudflare-backend/src/kv.js';
import { handleEmulator } from '../cloudflare-backend/src/emulator.js';

/** Counting KV stub that can be told to reject writes with a 429. */
function createKv({ failWith429 = false, failTimes = Infinity } = {}) {
  const store = new Map();
  let puts = 0;
  let rateLimited = 0;
  let remainingFailures = failTimes;
  return {
    store,
    get puts() { return puts; },
    get rateLimited() { return rateLimited; },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) {
      if (failWith429 && remainingFailures > 0) {
        remainingFailures -= 1;
        rateLimited += 1;
        const err = new Error('KV PUT failed: 429 Too Many Requests');
        err.status = 429;
        throw err;
      }
      puts += 1;
      store.set(key, value);
    },
    async delete(key) { store.delete(key); },
    async list() { return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true }; },
  };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  resetKvStats();
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

await test('identical value is written once, not repeatedly', async () => {
  const kv = createKv();
  const value = { status: 'online', model: 'Pixel 7' };
  for (let i = 0; i < 100; i += 1) {
    await kvPutJson(kv, 'emulator:default', value, { minIntervalMs: 0 });
  }
  assert.equal(kv.puts, 1, `expected 1 write for 100 identical puts, got ${kv.puts}`);
  assert.equal(kvStats().deduped, 99);
});

await test('changed value writes, and only when it changes', async () => {
  const kv = createKv();
  await kvPutJson(kv, 'k', { n: 1 }, { minIntervalMs: 0 });
  await kvPutJson(kv, 'k', { n: 1 }, { minIntervalMs: 0 });
  await kvPutJson(kv, 'k', { n: 2 }, { minIntervalMs: 0 });
  await kvPutJson(kv, 'k', { n: 2 }, { minIntervalMs: 0 });
  await kvPutJson(kv, 'k', { n: 3 }, { minIntervalMs: 0 });
  assert.equal(kv.puts, 3);
});

await test('throttle window suppresses writes inside the window', async () => {
  const kv = createKv();
  const window = 60_000;
  await kvPutJson(kv, 'k', { v: 1 }, { minIntervalMs: window });
  await kvPutJson(kv, 'k', { v: 2 }, { minIntervalMs: window });
  await kvPutJson(kv, 'k', { v: 3 }, { minIntervalMs: window });
  assert.equal(kv.puts, 1, 'only the first write inside the window should land');
  assert.equal(kvStats().throttled, 2);
});

await test('force bypasses dedupe and throttle (explicit user save)', async () => {
  const kv = createKv();
  await kvPutJson(kv, 'k', { v: 1 }, { minIntervalMs: 60_000 });
  await kvPutJson(kv, 'k', { v: 1 }, { minIntervalMs: 60_000, force: true });
  assert.equal(kv.puts, 2);
});

await test('429 is swallowed: the write reports rate-limit and never throws', async () => {
  const kv = createKv({ failWith429: true });
  const res = await kvPutJson(kv, 'k', { v: 1 }, { minIntervalMs: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'rate-limit');
  assert.equal(kvStats().rateLimited, 1);
  // No retry storm against a daily cap.
  assert.equal(kv.rateLimited, 1, 'a 429 must not be retried in-request');
});

await test('transient error is retried with backoff, then succeeds', async () => {
  const kv = createKv();
  let calls = 0;
  const flaky = {
    async put(key, value) {
      calls += 1;
      if (calls < 3) throw new Error('network blip');
      kv.store.set(key, value);
      return undefined;
    },
    async get(key) { return kv.store.get(key) ?? null; },
  };
  const res = await kvPutJson(flaky, 'k', { v: 1 }, { minIntervalMs: 0 });
  assert.equal(res.ok, true);
  assert.equal(calls, 3, 'two failures then success');
});

await test('kvGetJson returns null for a missing key and parses stored JSON', async () => {
  const kv = createKv();
  assert.equal(await kvGetJson(kv, 'absent'), null);
  await kvPutJson(kv, 'present', { a: 1 }, { minIntervalMs: 0 });
  assert.deepEqual(await kvGetJson(kv, 'present'), { a: 1 });
});

await test('kvGetJson tolerates malformed JSON instead of throwing', async () => {
  const kv = createKv();
  kv.store.set('bad', '{not json');
  assert.equal(await kvGetJson(kv, 'bad'), null);
});

/* ---------------- heartbeat behaviour against the real handler ---------- */

/**
 * D1 stub recording how many times the session row was rewritten.
 * `touchEmulatorHeartbeat` issues a conditional UPDATE; `upsertEmulatorSession`
 * rewrites every column. Only the second is expensive, so the counts are kept
 * apart to prove the steady-state beat takes the cheap path.
 */
function createDb(session) {
  const db = {
    session,
    sessionWrites: 0,
    heartbeatTouches: 0,
    prepare(sql) {
      const isTouch = /UPDATE emulator_sessions SET last_heartbeat/.test(sql);
      const isUpsert = /UPDATE emulator_sessions SET gateway_url/.test(sql);
      const isInsert = /INSERT INTO emulator_sessions/.test(sql);
      const isSelect = /SELECT (id|\*) FROM emulator_sessions/.test(sql);

      const execute = {
        async first() {
          if (isSelect) return db.session ? { ...db.session } : null;
          return null;
        },
        async run() {
          if (isTouch) {
            db.heartbeatTouches += 1;
            if (db.session) db.session.lastHeartbeat = 'touched';
            return { meta: { changes: db.session ? 1 : 0 } };
          }
          if (isUpsert || isInsert) {
            db.sessionWrites += 1;
            db.session = { ...(db.session || {}), id: 'default' };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async all() { return { results: [] }; },
      };
      // D1 supports both `prepare(sql).first()` and `prepare(sql).bind(...).first()`.
      return { ...execute, bind: () => execute };
    },
    async exec() {},
  };
  return db;
}

const cors = () => ({});
const heartbeat = (body = {}) => new Request('https://vexa.test/api/emulator/heartbeat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

await test('steady-state heartbeat writes no KV at all', async () => {
  const kv = createKv();
  const db = createDb({
    id: 'default',
    gatewayUrl: 'https://vexa.test',
    status: 'online',
    deviceModel: 'Pixel 7',
    androidVersion: '14',
    resolution: '1080x2400',
    loggedInAccount: 'preserved-session',
    activeRunId: '42',
    lastHeartbeat: new Date().toISOString(),
  });
  const env = { DB: db, SESSION_KV: kv };

  // 2,880 beats = one day of the old 30s heartbeat loop.
  for (let i = 0; i < 2880; i += 1) {
    const res = await handleEmulator(heartbeat({
      status: 'online', deviceModel: 'Pixel 7', resolution: '1080x2400', activeRunId: '42',
    }), env, {}, null, cors);
    assert.equal(res.status, 200);
  }

  assert.equal(kv.puts, 0, `a day of heartbeats must write no KV (got ${kv.puts})`);
  assert.equal(db.sessionWrites, 0, 'unchanged identity must not rewrite the session row');
  assert.equal(db.heartbeatTouches, 2880, 'the cheap heartbeat path handles every beat');
});

await test('heartbeat that reports a changed device rewrites the session once', async () => {
  const kv = createKv();
  const db = createDb({
    id: 'default',
    gatewayUrl: 'https://vexa.test',
    status: 'online',
    deviceModel: 'Pixel 7',
    androidVersion: '14',
    resolution: '1080x2400',
    lastHeartbeat: new Date().toISOString(),
  });
  const env = { DB: db, SESSION_KV: kv };

  const res = await handleEmulator(heartbeat({ status: 'online', deviceModel: 'Pixel 8' }), env, {}, null, cors);
  assert.equal(res.status, 200);
  assert.equal(db.sessionWrites, 1, 'a real identity change must persist');
  assert.ok(kv.puts <= 1, 'cache refresh is allowed but capped');
});

await test('a KV 429 during heartbeat does not fail the request', async () => {
  const kv = createKv({ failWith429: true });
  const db = createDb(null); // no existing session → forces the write path
  const env = { DB: db, SESSION_KV: kv };

  const res = await handleEmulator(heartbeat({ status: 'online', deviceModel: 'Pixel 7' }), env, {}, null, cors);
  assert.equal(res.status, 200, 'registration must survive an exhausted KV quota');
  assert.equal(db.sessionWrites, 1, 'D1 still holds the session');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
