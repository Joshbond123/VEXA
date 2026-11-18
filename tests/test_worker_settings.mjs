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

console.log(`\n${passed} passed, 0 failed`);
