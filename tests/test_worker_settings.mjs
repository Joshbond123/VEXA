/**
 * Regression tests for the VEXA settings save/load path in the Cloudflare Worker.
 *
 * The frontend posts `apiKeys` (newline separated), but the worker previously
 * read only `body.apiKey`, so every saved key was silently dropped and the
 * Settings page came back empty after a refresh. These tests drive the real
 * `handleFrontend` handler; only Workers KV is stubbed because it is a platform
 * API that does not exist outside Cloudflare.
 *
 * Run: node tests/test_worker_settings.mjs
 */
import assert from 'node:assert/strict';
import { handleFrontend } from '../cloudflare-backend/src/frontend.js';

// Minimal in-memory stand-in for the Workers KV binding.
function createKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

const env = { CONFIG_KV: createKv(), DB: {} };
const corsHeaders = () => ({});
const post = (body) => new Request('https://vexa.test/api/frontend/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const get = () => new Request('https://vexa.test/api/frontend/settings', { method: 'GET' });

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log(`  ok  ${name}`); });
}

await test('settings POST persists apiKeys (newline separated) and GET reports hasApiKey', async () => {
  const res = await handleFrontend(post({
    provider: 'nvidia',
    apiKeys: 'nvapi-first\nnvapi-second',
    githubRepo: 'Joshbond123/VEXA',
  }), env, {}, null, corsHeaders);
  assert.equal(res.status, 200);
  const saved = JSON.parse(env.CONFIG_KV.store.get('settings_config'));
  assert.equal(saved.apiKeyEncrypted, 'nvapi-first\nnvapi-second',
    'the newline-separated apiKeys value must survive the save');

  const readRes = await handleFrontend(get(), env, {}, null, corsHeaders);
  const data = await readRes.json();
  assert.equal(data.settings.hasApiKey, true, 'GET must report that a key is stored');
});

await test('settings POST still accepts the legacy apiKey field', async () => {
  const kv = createKv();
  await handleFrontend(post({ provider: 'nvidia', apiKey: 'legacy-key' }), { CONFIG_KV: kv, DB: {} }, {}, null, corsHeaders);
  const saved = JSON.parse(kv.store.get('settings_config'));
  assert.equal(saved.apiKeyEncrypted, 'legacy-key');
});

await test('settings POST never echoes secrets back to the client', async () => {
  const res = await handleFrontend(post({ apiKeys: 'super-secret-value' }), env, {}, null, corsHeaders);
  const body = await res.text();
  assert.ok(!body.includes('super-secret-value'), 'raw key must not appear in the response');
});

await test('GET /api/frontend/settings tolerates an empty KV (no crash)', async () => {
  const res = await handleFrontend(get(), { CONFIG_KV: createKv(), DB: {} }, {}, null, corsHeaders);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  // An empty KV yields no stored key; the field is simply absent (falsy).
  assert.ok(!data.settings.hasApiKey, 'hasApiKey must be falsy when nothing is stored');
});

await test('saving a non-secret field preserves the stored API key', async () => {
  // Regression: the handler wrote apiKeyEncrypted from the request body only,
  // so saving e.g. the repo name blanked the key and the agent then failed with
  // "No API key configured".
  const kv = createKv();
  const env2 = { CONFIG_KV: kv, DB: {} };
  await handleFrontend(post({ apiKeys: 'nvapi-secret', githubRepo: 'Joshbond123/VEXA' }), env2, {}, null, corsHeaders);
  assert.ok(JSON.parse(kv.store.get('settings_config')).apiKeyEncrypted, 'key stored after first save');

  await handleFrontend(post({ provider: 'nvidia', githubRepo: 'Joshbond123/VEXA' }), env2, {}, null, corsHeaders);
  const after = JSON.parse(kv.store.get('settings_config'));
  assert.equal(after.apiKeyEncrypted, 'nvapi-secret', 'key must survive a save that omits it');

  const res = await handleFrontend(get(), env2, {}, null, corsHeaders);
  assert.equal((await res.json()).settings.hasApiKey, true);
});

await test('saving a non-secret field preserves the stored GitHub PAT', async () => {
  const kv = createKv();
  const env2 = { CONFIG_KV: kv, DB: {} };
  await handleFrontend(post({ githubPat: 'ghp_secret' }), env2, {}, null, corsHeaders);
  await handleFrontend(post({ provider: 'openai' }), env2, {}, null, corsHeaders);
  assert.equal(JSON.parse(kv.store.get('settings_config')).githubPatEncrypted, 'ghp_secret');
});

console.log(`\n${passed} passed, 0 failed`);

// ── D1 path (the live store) ────────────────────────────────────────────────
// The agent runner reads settings from D1 via getSettings(env.DB), and KV has a
// daily write cap, so D1 must be the store that settings POST writes and GET
// reads. A minimal D1 stand-in exercises the real SQL against an in-memory row.
function createD1() {
  const row = {};
  const map = { gateway_url: 'gatewayUrl', provider: 'provider', model: 'model',
    api_key_encrypted: 'apiKeyEncrypted', github_pat_encrypted: 'githubPatEncrypted',
    github_repo: 'githubRepo', cloudflare_account_id: 'cloudflareAccountId',
    cloudflare_api_token_encrypted: 'cloudflareApiTokenEncrypted', key_rotation: 'keyRotation' };
  const db = {
    prepare(sql) {
      const stmt = { _args: [], bind(...a) { this._args = a; return this; },
        async first() { return Object.keys(row).length ? { id: 'default', ...row } : null; },
        async run() {
          if (sql.startsWith('INSERT')) {
            const cols = ['gatewayUrl','provider','model','apiKeyEncrypted','githubPatEncrypted',
              'githubRepo','cloudflareAccountId','cloudflareApiTokenEncrypted','keyRotation'];
            cols.forEach((c, i) => { row[c] = this._args[i + 1]; });
          } else if (sql.startsWith('UPDATE')) {
            const cols = ['gatewayUrl','provider','model','apiKeyEncrypted','githubPatEncrypted',
              'githubRepo','cloudflareAccountId','cloudflareApiTokenEncrypted','keyRotation'];
            cols.forEach((c, i) => { row[c] = this._args[i]; });
          }
          return { success: true };
        } };
      return stmt;
    },
    async exec() {},
  };
  return db;
}

await test('D1: saving a non-secret field preserves the stored API key', async () => {
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  await handleFrontend(post({ apiKeys: 'nvapi-keep-me', githubRepo: 'a/b' }), env, {}, null, corsHeaders);
  await handleFrontend(post({ githubRepo: 'Joshbond123/VEXA' }), env, {}, null, corsHeaders);
  const res = await handleFrontend(get(), env, {}, null, corsHeaders);
  const data = await res.json();
  assert.equal(data.settings.hasApiKey, true, 'the API key must survive a repo-only save on D1');
  assert.equal(data.settings.githubRepo, 'Joshbond123/VEXA', 'the new repo must be stored');
});

await test('D1: GET reads settings the agent runner would read', async () => {
  const env = { CONFIG_KV: createKv(), DB: createD1() };
  await handleFrontend(post({ provider: 'xai', apiKeys: 'xai-key', model: 'grok' }), env, {}, null, corsHeaders);
  const res = await handleFrontend(get(), env, {}, null, corsHeaders);
  const data = await res.json();
  assert.equal(data.settings.provider, 'xai');
  assert.equal(data.settings.model, 'grok');
  assert.equal(data.settings.hasApiKey, true);
});

console.log(`\n${passed} passed, 0 failed`);
