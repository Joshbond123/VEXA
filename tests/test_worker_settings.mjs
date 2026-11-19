/**
 * Regression tests for the VEXA settings save/load path in the Cloudflare Worker.
 *
 * Two behaviours are pinned here:
 *   1. A save must merge onto the stored config, so saving a non-secret field
 *      never blanks the API key or GitHub PAT (the bug that made the agent fail
 *      with "No API key configured" after an unrelated save).
 *   2. Settings live in D1 only. They used to be mirrored into KV on every save,
 *      which burned the 1,000-writes/day KV budget for no benefit — every read
 *      already prefers D1. A save must therefore produce zero KV writes.
 *
 * Run: node tests/test_worker_settings.mjs
 */
import assert from 'node:assert/strict';
import { handleFrontend } from '../cloudflare-backend/src/frontend.js';

// Minimal in-memory stand-in for the Workers KV binding.
function createKv() {
  const store = new Map();
  let puts = 0;
  return {
    store,
    get puts() { return puts; },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { puts += 1; store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

/**
 * Minimal D1 stand-in holding the single settings row, exercising the real SQL
 * that upsertSettings/getSettings issue against a live database.
 */
function createD1() {
  const row = {};
  const columns = ['gatewayUrl', 'provider', 'model', 'apiKeyEncrypted', 'githubPatEncrypted',
    'githubRepo', 'cloudflareAccountId', 'cloudflareApiTokenEncrypted', 'keyRotation'];
  return {
    row,
    prepare(sql) {
      return {
        _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (sql.startsWith('SELECT') && sql.includes('settings')) {
            return Object.keys(row).length ? { id: 'default', ...row } : null;
          }
          return null;
        },
        async run() {
          if (sql.startsWith('INSERT')) {
            // bind order: id, ...columns, updated_at
            columns.forEach((c, i) => { row[c] = this._args[i + 1]; });
          } else if (sql.startsWith('UPDATE')) {
            // bind order: ...columns, updated_at, id
            columns.forEach((c, i) => { row[c] = this._args[i]; });
          }
          return { success: true };
        },
        async all() { return { results: [] }; },
      };
    },
    async exec() {},
  };
}

const corsHeaders = () => ({});
const post = (body) => new Request('https://vexa.test/api/frontend/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const get = () => new Request('https://vexa.test/api/frontend/settings', { method: 'GET' });

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

await test('settings POST persists newline-separated apiKeys and GET reports hasApiKey', async () => {
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  const res = await handleFrontend(post({
    provider: 'nvidia',
    apiKeys: 'nvapi-first\nnvapi-second',
    githubRepo: 'Joshbond123/VEXA',
  }), env, {}, null, corsHeaders);
  assert.equal(res.status, 200);

  assert.equal(env.DB.row.apiKeyEncrypted, 'nvapi-first\nnvapi-second',
    'the newline-separated apiKeys value must survive the save');

  const data = await (await handleFrontend(get(), env, {}, null, corsHeaders)).json();
  assert.equal(data.settings.hasApiKey, true, 'GET must report that a key is stored');
});

await test('settings POST still accepts the legacy apiKey field', async () => {
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  await handleFrontend(post({ provider: 'nvidia', apiKey: 'legacy-key' }), env, {}, null, corsHeaders);
  assert.equal(env.DB.row.apiKeyEncrypted, 'legacy-key');
});

await test('settings POST never echoes secrets back to the client', async () => {
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  const res = await handleFrontend(post({ apiKeys: 'super-secret-value' }), env, {}, null, corsHeaders);
  const body = await res.text();
  assert.ok(!body.includes('super-secret-value'), 'raw key must not appear in the response');
});

await test('saving settings performs zero KV writes', async () => {
  const kv = createKv();
  const env = { CONFIG_KV: kv, DB: createD1() };
  await handleFrontend(post({ apiKeys: 'nvapi-a', githubRepo: 'a/b' }), env, {}, null, corsHeaders);
  await handleFrontend(post({ provider: 'openai' }), env, {}, null, corsHeaders);
  await handleFrontend(post({ model: 'gpt-4o-mini' }), env, {}, null, corsHeaders);
  assert.equal(kv.puts, 0, `settings saves must not consume KV write budget (got ${kv.puts})`);
  assert.equal(env.DB.row.apiKeyEncrypted, 'nvapi-a', 'D1 still holds the value');
});

await test('GET tolerates a completely empty store (no crash)', async () => {
  const res = await handleFrontend(get(), { CONFIG_KV: createKv(), DB: createD1() }, {}, null, corsHeaders);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(!data.settings.hasApiKey, 'hasApiKey must be falsy when nothing is stored');
});

await test('saving a non-secret field preserves the stored API key', async () => {
  // Regression: the handler wrote apiKeyEncrypted from the request body only,
  // so saving e.g. the repo name blanked the key and the agent then failed with
  // "No API key configured".
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  await handleFrontend(post({ apiKeys: 'nvapi-secret', githubRepo: 'Joshbond123/VEXA' }), env, {}, null, corsHeaders);
  assert.ok(env.DB.row.apiKeyEncrypted, 'key stored after first save');

  await handleFrontend(post({ provider: 'nvidia', githubRepo: 'Joshbond123/VEXA' }), env, {}, null, corsHeaders);
  assert.equal(env.DB.row.apiKeyEncrypted, 'nvapi-secret', 'key must survive a save that omits it');

  const data = await (await handleFrontend(get(), env, {}, null, corsHeaders)).json();
  assert.equal(data.settings.hasApiKey, true);
});

await test('saving a non-secret field preserves the stored GitHub PAT', async () => {
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  await handleFrontend(post({ githubPat: 'ghp_secret' }), env, {}, null, corsHeaders);
  await handleFrontend(post({ provider: 'openai' }), env, {}, null, corsHeaders);
  assert.equal(env.DB.row.githubPatEncrypted, 'ghp_secret');
});

await test('GET reads back the provider, model and repo the agent runner would see', async () => {
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  await handleFrontend(post({ provider: 'xai', apiKeys: 'xai-key', model: 'grok', githubRepo: 'Joshbond123/VEXA' }),
    env, {}, null, corsHeaders);
  const data = await (await handleFrontend(get(), env, {}, null, corsHeaders)).json();
  assert.equal(data.settings.provider, 'xai');
  assert.equal(data.settings.model, 'grok');
  assert.equal(data.settings.githubRepo, 'Joshbond123/VEXA');
  assert.equal(data.settings.hasApiKey, true);
});

await test('legacy KV-only settings are still readable when D1 has no row', async () => {
  // A deployment upgraded from the KV-mirror era must not lose its config: reads
  // fall back to the KV mirror when D1 is empty.
  const kv = createKv();
  kv.store.set('settings_config', JSON.stringify({ provider: 'nvidia', apiKeyEncrypted: 'nvapi-old' }));
  const data = await (await handleFrontend(get(), { CONFIG_KV: kv, DB: createD1() }, {}, null, corsHeaders)).json();
  assert.equal(data.settings.hasApiKey, true, 'the KV fallback still surfaces the stored key');
  assert.equal(data.settings.provider, 'nvidia');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
