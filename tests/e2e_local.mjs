/**
 * Local end-to-end harness for the VEXA Worker.
 *
 * Runs the real `fetch` handler from `src/index.js` behind a Node HTTP server
 * against an in-memory D1/KV, plus a simulated Android emulator that polls for
 * actions and posts real results back. This is what proves the loop works as a
 * system — HTTP, SSE, D1 writes, action handshake and all — without needing
 * Cloudflare or a live device.
 *
 * Run: node tests/e2e_local.mjs
 *   E2E_LIVE=1 to also hit the real NVIDIA provider (needs NVIDIA_API_KEY).
 */
import http from 'node:http';
import worker from '../cloudflare-backend/src/index.js';
import { initDatabase } from '../cloudflare-backend/src/database.js';

/* ------------------------------------------------------------ in-memory D1 */

/**
 * A small SQLite-ish shim: enough for the statements this Worker issues.
 * Rather than emulate SQL, each handler recognises the query it is given. The
 * row shapes mirror the real schema in database.js.
 */
function createD1() {
  const tables = {
    settings: new Map(),
    emulator_sessions: new Map(),
    device_state: new Map(),
    conversations: new Map(),
    chat_messages: [],
    agent_events: [],
    automations: new Map(),
    executions: new Map(),
    access_tokens: new Map(),
  };

  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const rowOut = (row) => {
    if (!row) return null;
    const out = {};
    for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
    return out;
  };

  function run(sql, args) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/CREATE TABLE|CREATE INDEX/i.test(s)) return { meta: { changes: 0 } };

    // ---- settings
    if (/^(INSERT INTO settings|INSERT OR REPLACE INTO settings)/i.test(s)) {
      const cols = ['gateway_url', 'provider', 'model', 'api_key_encrypted', 'github_pat_encrypted',
        'github_repo', 'cloudflare_account_id', 'cloudflare_api_token_encrypted', 'key_rotation'];
      const row = { id: args[0], updated_at: args[args.length - 1] };
      cols.forEach((c, i) => { row[c] = args[i + 1]; });
      tables.settings.set('default', row);
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE settings SET/i.test(s)) {
      const cols = ['gateway_url', 'provider', 'model', 'api_key_encrypted', 'github_pat_encrypted',
        'github_repo', 'cloudflare_account_id', 'cloudflare_api_token_encrypted', 'key_rotation'];
      const row = { id: 'default', updated_at: args[args.length - 2] };
      cols.forEach((c, i) => { row[c] = args[i]; });
      tables.settings.set('default', row);
      return { meta: { changes: 1 } };
    }

    // ---- emulator session
    if (/^INSERT INTO emulator_sessions/i.test(s) || /^INSERT OR REPLACE INTO emulator_sessions/i.test(s)) {
      const cols = ['id', 'gateway_url', 'status', 'device_model', 'android_version', 'resolution',
        'logged_in_account', 'active_run_id', 'last_heartbeat'];
      const row = {};
      cols.forEach((c, i) => { row[c] = args[i]; });
      tables.emulator_sessions.set(row.id || 'default', row);
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE emulator_sessions SET last_heartbeat/i.test(s)) {
      const row = tables.emulator_sessions.get('default');
      if (row) row.last_heartbeat = args[0];
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (/^UPDATE emulator_sessions/i.test(s)) {
      const cols = ['gateway_url', 'status', 'device_model', 'android_version', 'resolution',
        'logged_in_account', 'active_run_id', 'last_heartbeat'];
      const row = tables.emulator_sessions.get('default') || { id: 'default' };
      cols.forEach((c, i) => { if (args[i] !== undefined) row[c] = args[i]; });
      tables.emulator_sessions.set('default', row);
      return { meta: { changes: 1 } };
    }

    // ---- device state (the action handshake)
    if (/^INSERT INTO device_state/i.test(s) || /^INSERT OR REPLACE INTO device_state/i.test(s)) {
      const cols = ['screen_checksum', 'last_screenshot_url', 'last_screenshot_small_url', 'last_action',
        'last_action_result', 'last_action_client_id', 'last_action_status', 'ui_hierarchy'];
      const row = { id: 'current' };
      cols.forEach((c, i) => { row[c] = args[i]; });
      tables.device_state.set('current', row);
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE device_state SET screen_checksum/i.test(s)) {
      const row = tables.device_state.get('current') || { id: 'current' };
      const cols = ['screen_checksum', 'last_screenshot_url', 'last_screenshot_small_url', 'last_action',
        'last_action_result', 'last_action_client_id', 'last_action_status', 'ui_hierarchy'];
      cols.forEach((c, i) => { if (args[i] !== undefined) row[c] = args[i]; });
      tables.device_state.set('current', row);
      return { meta: { changes: 1 } };
    }
    if (/UPDATE device_state SET last_action = \?/i.test(s)) {
      const row = tables.device_state.get('current');
      if (!row) return { meta: { changes: 0 } };
      // claimDeviceAction: only claim when nothing else is pending for this client
      const [actionJson, clientId] = args;
      if (row.last_action_status === 'pending' && row.last_action_client_id && row.last_action_client_id !== clientId) {
        return { meta: { changes: 0 } };
      }
      row.last_action = actionJson;
      row.last_action_result = 'pending';
      row.last_action_client_id = clientId;
      row.last_action_status = 'pending';
      return { meta: { changes: 1 } };
    }

    // ---- conversations
    if (/^INSERT INTO conversations/i.test(s) || /^INSERT OR REPLACE INTO conversations/i.test(s)) {
      const cols = ['id', 'title', 'automation_id', 'status', 'created_at', 'updated_at'];
      const row = {};
      cols.forEach((c, i) => { row[c] = args[i]; });
      const existing = tables.conversations.get(row.id);
      tables.conversations.set(row.id, { ...existing, ...row });
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE conversations SET updated_at/i.test(s)) {
      const row = tables.conversations.get(args[args.length - 1]);
      if (row) row.updated_at = args[0];
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (/^UPDATE conversations SET title/i.test(s)) {
      const row = tables.conversations.get(args[args.length - 1]);
      if (row) row.title = args[0];
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (/^DELETE FROM conversations/i.test(s)) {
      tables.conversations.delete(args[0]);
      return { meta: { changes: 1 } };
    }

    // ---- chat messages
    if (/^INSERT INTO chat_messages/i.test(s)) {
      tables.chat_messages.push({
        id: args[0], automation_id: args[1], role: args[2], content: args[3], timestamp: args[4],
      });
      return { meta: { changes: 1 } };
    }

    // ---- agent events
    if (/^INSERT INTO agent_events/i.test(s)) {
      tables.agent_events.push({
        id: args[0], conversation_id: args[1], automation_id: args[2], execution_id: args[3],
        kind: args[4], title: args[5], detail: args[6], status: args[7], seq: args[8], created_at: args[9],
      });
      return { meta: { changes: 1 } };
    }

    // ---- automations / executions
    if (/^INSERT INTO automations/i.test(s) || /^INSERT OR REPLACE INTO automations/i.test(s)) {
      tables.automations.set(args[0], { id: args[0], raw: args });
      return { meta: { changes: 1 } };
    }
    if (/^INSERT INTO executions/i.test(s)) {
      tables.executions.set(args[0], { id: args[0], raw: args });
      return { meta: { changes: 1 } };
    }

    // ---- access tokens
    if (/^INSERT INTO access_tokens/i.test(s) || /^INSERT OR IGNORE INTO access_tokens/i.test(s)) {
      if (!tables.access_tokens.has(args[0]) || !/OR IGNORE/i.test(s)) {
        tables.access_tokens.set(args[0], { token: args[0], payload: args[1], expires_at: args[2] });
      }
      return { meta: { changes: 1 } };
    }
    if (/^DELETE FROM access_tokens/i.test(s)) {
      tables.access_tokens.delete(args[0]);
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }

  function first(sql, args) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/FROM settings/i.test(s)) return rowOut(tables.settings.get('default'));
    if (/FROM emulator_sessions/i.test(s)) {
      return rowOut(tables.emulator_sessions.get('default')) || null;
    }
    if (/FROM device_state/i.test(s)) return rowOut(tables.device_state.get('current'));
    if (/FROM conversations WHERE id = \?/i.test(s)) return rowOut(tables.conversations.get(args[0]));
    if (/FROM conversations/i.test(s)) {
      return [...tables.conversations.values()].map(rowOut)[0] || null;
    }
    if (/MAX\(seq\)/i.test(s)) {
      const rows = tables.agent_events.filter((e) => (args[0] === null || e.conversation_id === args[0]));
      return { maxSeq: rows.reduce((m, e) => Math.max(m, e.seq || 0), 0) };
    }
    if (/FROM access_tokens/i.test(s)) {
      const t = tables.access_tokens.get(args[0]);
      return t ? { payload: t.payload, expires_at: t.expires_at } : null;
    }
    if (/FROM automations WHERE id/i.test(s)) {
      const a = tables.automations.get(args[0]);
      return a ? { id: a.id, name: 'x', instructions: '', enabled: 1 } : null;
    }
    if (/FROM executions/i.test(s)) return null;
    return null;
  }

  function all(sql, args) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/FROM agent_events/i.test(s)) {
      let rows = tables.agent_events.slice();
      // seq > ? plus optional conversation/automation filters
      const after = Number(args[0] || 0);
      rows = rows.filter((e) => (e.seq || 0) > after);
      if (args.includes('conversation') || s.includes('conversation_id = ?')) {
        const cid = args[1];
        rows = rows.filter((e) => e.conversation_id === cid);
      }
      return { results: rows.sort((a, b) => a.seq - b.seq) };
    }
    if (/FROM conversations/i.test(s)) {
      return { results: [...tables.conversations.values()].map(rowOut) };
    }
    if (/FROM chat_messages/i.test(s)) {
      return { results: tables.chat_messages.slice() };
    }
    if (/FROM automations/i.test(s)) {
      return { results: [...tables.automations.values()].map((a) => ({ id: a.id, name: 'x', enabled: 1 })) };
    }
    if (/FROM executions/i.test(s)) return { results: [] };
    return { results: [] };
  }

  return {
    tables,
    prepare(sql) {
      return {
        _args: [],
        bind(...a) { this._args = a; return this; },
        async first() { return first(sql, this._args); },
        async run() { return run(sql, this._args); },
        async all() { return all(sql, this._args); },
      };
    },
    async exec(sql) {
      // initDatabase issues one big CREATE TABLE batch; run() ignores DDL.
      return { meta: { changes: 0 } };
    },
    async batch(stmts) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
}

function createKv() {
  const store = new Map();
  let puts = 0;
  return {
    store,
    get puts() { return puts; },
    async get(key, opts) {
      if (opts && opts.type === 'json') {
        const v = store.get(key);
        return v ? JSON.parse(v) : null;
      }
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) { puts += 1; store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

/* --------------------------------------------------------- simulated device */

import zlib from 'node:zlib';

/** Build a real PNG (gradient) at phone resolution, like adb screencap produces. */
function makePng(w = 540, h = 960) {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0;
    for (let x = 0; x < w; x += 1) {
      const i = 1 + x * 3;
      row[i] = (y * 255 / h) | 0; row[i + 1] = (x * 255 / w) | 0; row[i + 2] = 128;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_1PX = `data:image/png;base64,${makePng().toString('base64')}`;

/**
 * Stands in for the real emulator loop: polls the Worker for a pending action,
 * executes it against its own app model, uploads the new frame and result.
 * This is the same handshake the real bridge performs.
 */
function startSimulatedEmulator({ baseUrl, screens }) {
  let app = 'Home';
  let frame = 0;
  let running = true;
  const executed = [];

  const upload = async (extra) => {
    const xml = `<hierarchy><node text="${app}" bounds="[0,0][1080,1920]"/></hierarchy>`;
    await fetch(`${baseUrl}/api/emulator/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screenshotBase64: PNG_1PX.split(',')[1],
        checksum: `frame-${frame}`,
        uiHierarchy: Buffer.from(xml).toString('base64'),
        ...extra,
      }),
    }).catch(() => null);
  };

  const loop = async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, 120));
      let pending;
      try {
        pending = await (await fetch(`${baseUrl}/api/emulator/pending-action`)).json();
      } catch { continue; }
      if (!pending.action) continue;

      const action = pending.action;
      app = screens[action.action] || app;
      frame += 1;
      executed.push({ action, app });

      await upload();
      await fetch(`${baseUrl}/api/emulator/action-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          success: true,
          screenshotBase64: PNG_1PX.split(',')[1],
          checksum: `frame-${frame}`,
          uiHierarchy: Buffer.from(`<hierarchy><node text="${app}"/></hierarchy>`).toString('base64'),
        }),
      }).catch(() => null);
    }
  };

  loop();
  return { stop: () => { running = false; }, get executed() { return executed; }, get app() { return app; } };
}

/* ------------------------------------------------------------------- server */

const env = {
  DB: createD1(),
  CONFIG_KV: createKv(),
  SESSION_KV: createKv(),
  EMULATOR_ACCESS_TOKEN: 'test-emulator-token',
  ENVIRONMENT: 'test',
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
  try {
    const response = await worker.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, stack: err.stack }));
  }
});

await new Promise((r) => server.listen(0, r));
const baseUrl = `http://localhost:${server.address().port}`;

/* -------------------------------------------------------------------- tests */

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

await initDatabase(env.DB);

await test('GET /api/health reports the deployed version', async () => {
  const r = await (await fetch(`${baseUrl}/api/health`)).json();
  assertEqual(r.ok, true);
  assertEqual(r.version, '2.1.0');
});

await test('GET /api/health/kv exposes KV write accounting', async () => {
  const r = await (await fetch(`${baseUrl}/api/health/kv`)).json();
  assertEqual(r.ok, true);
  assertEqual(typeof r.written, 'number');
});

await test('settings round-trip through the real handler', async () => {
  const save = await fetch(`${baseUrl}/api/frontend/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'nvidia', apiKeys: 'nvapi-test-key', githubRepo: 'Joshbond123/VEXA' }),
  });
  assertEqual(save.status, 200);
  const read = await (await fetch(`${baseUrl}/api/frontend/settings`)).json();
  assertEqual(read.settings.hasApiKey, true);
  assertEqual(read.settings.githubRepo, 'Joshbond123/VEXA');
});

await test('settings saves write no KV', async () => {
  const before = env.CONFIG_KV.puts;
  for (let i = 0; i < 10; i += 1) {
    await fetch(`${baseUrl}/api/frontend/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'nvidia' }),
    });
  }
  assertEqual(env.CONFIG_KV.puts, before, 'settings must persist to D1 only');
});

await test('emulator registration makes the session online', async () => {
  const r = await fetch(`${baseUrl}/api/emulator/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gatewayUrl: baseUrl, deviceModel: 'Pixel 7', androidVersion: '14', resolution: '1080x1920',
      accessToken: env.EMULATOR_ACCESS_TOKEN,
    }),
  });
  assertEqual(r.status, 200);
  const s = await (await fetch(`${baseUrl}/api/emulator/status`)).json();
  assertEqual(s.session.status, 'online');
  assertEqual(s.session.resolution, '1080x1920');
});

await test('a full day of heartbeats writes no KV and keeps the session online', async () => {
  const before = env.SESSION_KV.puts;
  for (let i = 0; i < 300; i += 1) {
    await fetch(`${baseUrl}/api/emulator/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online', deviceModel: 'Pixel 7', resolution: '1080x1920' }),
    });
  }
  assertEqual(env.SESSION_KV.puts, before, 'heartbeats must not consume KV write budget');
  const s = await (await fetch(`${baseUrl}/api/emulator/status`)).json();
  assertEqual(s.session.status, 'online');
});

await test('GET /api/public/device-state returns a real frame and UI tree', async () => {
  await fetch(`${baseUrl}/api/emulator/screenshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      screenshotBase64: PNG_1PX.split(',')[1],
      uiHierarchy: Buffer.from('<hierarchy><node text="Home"/></hierarchy>').toString('base64'),
      checksum: 'seed-frame',
    }),
  });
  const d = await (await fetch(`${baseUrl}/api/public/device-state`)).json();
  assertEqual(d.ok, true);
  assertEqual(typeof d.uiHierarchy, 'string', 'the UI tree must reach the agent');
  assertOk(String(d.screenshotUrl || '').startsWith('data:image/png'), 'a real frame must be served');
});

await test('POST /api/public/agent/run streams real steps over SSE', async () => {
  const emu = startSimulatedEmulator({ baseUrl, screens: { tap: 'Settings', scroll: 'Display' } });
  try {
    // Seed a starting frame so the loop has something to observe.
    await fetch(`${baseUrl}/api/emulator/screenshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screenshotBase64: PNG_1PX.split(',')[1],
        uiHierarchy: Buffer.from('<hierarchy><node text="Home"/></hierarchy>').toString('base64'),
        checksum: 'frame-0',
      }),
    });

    const res = await fetch(`${baseUrl}/api/frontend/agent/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'Open Settings and read the brightness.' }),
    });
    assertEqual(res.status, 200);
    assertEqual(res.headers.get('content-type'), 'text/event-stream');

    const text = await res.text();
    assertOk(text.includes('event: open'), 'stream announces the run');
    assertOk(text.includes('event: activity'), 'stream carries activity frames');
    assertOk(/event: (done|failed)/.test(text), 'stream terminates with a verdict');
  } finally {
    emu.stop();
  }
});

await test('the run endpoint rejects an empty task', async () => {
  const r = await fetch(`${baseUrl}/api/frontend/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: '' }),
  });
  assertEqual(r.status, 400);
});

await test('LIVE: the agent drives the phone with a real model and real actions', async () => {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) { console.log('       (skipped: NVIDIA_API_KEY not set)'); return; }

  // Configure the provider exactly as the Settings page would.
  await fetch(`${baseUrl}/api/frontend/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'nvidia', apiKeys: key }),
  });

  const emu = startSimulatedEmulator({
    baseUrl,
    screens: { tap: 'Settings', launch: 'Settings', scroll: 'Display' },
  });
  try {
    await fetch(`${baseUrl}/api/emulator/screenshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screenshotBase64: PNG_1PX.split(',')[1],
        uiHierarchy: Buffer.from('<hierarchy><node text="Home screen" bounds="[0,0][1080,1920]"/></hierarchy>').toString('base64'),
        checksum: 'live-seed',
      }),
    });

    const res = await fetch(`${baseUrl}/api/frontend/agent/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'Open the Settings app on this phone.' }),
    });
    const text = await res.text();
    if (process.env.E2E_DEBUG) console.log('---- SSE ----\n' + text.slice(0, 4000) + '\n---- end ----');

    assertOk(text.includes('event: open'), 'stream opened');
    const acts = (text.match(/event: activity/g) || []).length;
    assertOk(acts >= 3, `expected several real activity frames, saw ${acts}`);
    assertOk(/event: (done|failed)/.test(text), 'stream concluded');

    // The decisive proof: the model's decision reached the device and the device
    // reported back, so the loop could observe a new screen.
    assertOk(emu.executed.length >= 1,
      `the agent must have executed at least one real action (saw ${emu.executed.length})`);
    console.log(`       executed ${emu.executed.length} action(s): ${
      emu.executed.map((e) => e.action.action).join(', ')}`);
  } finally {
    emu.stop();
  }
});

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertOk(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
server.close();
process.exit(failures.length ? 1 : 0);
