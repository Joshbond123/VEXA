/**
 * VEXA Platform E2E Tests
 * Tests all Cloudflare backend integration components end-to-end.
 * 
 * Run with: node tests/e2e.test.mjs
 * Requires: fetch API (Node 18+)
 * Secrets must be passed via env vars: NVIDIA_API_KEY, GH_PAT
 */

const WORKER_URL = 'https://vexa-ai-agent.replyraven001.workers.dev';
const RESULTS = { pass: 0, fail: 0, skipped: 0 };

function assert(condition, name) {
  if (condition) {
    RESULTS.pass++;
    console.log(`  ✅ PASS: ${name}`);
  } else {
    RESULTS.fail++;
    console.log(`  ❌ FAIL: ${name}`);
  }
}

async function fetchJSON(path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  let body;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, ok: res.ok, body };
}

async function test(name, fn) {
  try {
    await fn();
  } catch (err) {
    RESULTS.fail++;
    console.log(`  ❌ FAIL: ${name} — ${err.message}`);
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  VEXA Platform E2E Test Suite                  ║');
  console.log(`║  Worker: ${WORKER_URL}  ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ──────────────────────────────────────────────
  // 1. Health & API Info
  // ──────────────────────────────────────────────
  console.log('─ Health & API ─────────────────────────────────');

  await test('Health endpoint returns ok', async () => {
    const r = await fetchJSON('/health');
    assert(r.ok && r.body.ok === true, 'Health ok:true');
    assert(r.body.service === 'vexa-ai-agent', 'Service name correct');
  });

  await test('API root lists endpoints', async () => {
    const r = await fetchJSON('/api');
    assert(r.ok && r.body.endpoints, 'API info returned');
    assert(r.body.endpoints.health === '/api/health', 'Health endpoint listed');
    assert(r.body.endpoints.settings === '/api/settings/*', 'Settings endpoint listed');
  });

  // ──────────────────────────────────────────────
  // 2. Settings (KV-based)
  // ──────────────────────────────────────────────
  console.log('\n─ Settings API ─────────────────────────────────');

  await test('GET settings returns config', async () => {
    const r = await fetchJSON('/api/settings');
    assert(r.ok, 'Settings GET returns ok');
    assert(r.body.settings.provider === 'nvidia', 'Provider is nvidia');
    assert(r.body.settings.model === 'nemotron-3.5-super-vl-120b-a12b', 'Model set');
    assert(r.body.settings.keyRotation === true, 'Key rotation enabled');
  });

  await test('POST settings saves config', async () => {
    const r = await fetchJSON('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        gatewayUrl: 'https://vexa-ai-agent.replyraven001.workers.dev',
        provider: 'nvidia',
        model: 'nemotron-3.5-super-vl-120b-a12b',
        keyRotation: true,
      }),
    });
    assert(r.ok && r.body.ok === true, 'Settings POST saves ok');
  });

  await test('GET settings after POST returns saved values', async () => {
    const r = await fetchJSON('/api/settings');
    assert(r.ok && r.body.settings.gatewayUrl === 'https://vexa-ai-agent.replyraven001.workers.dev', 'Gateway URL persisted');
  });

  // ──────────────────────────────────────────────
  // 3. Connection Tests
  // ──────────────────────────────────────────────
  console.log('\n─ Connection Tests ─────────────────────────────');

  await test('NVIDIA AI connection test (skipped if no key)', async () => {
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    if (!nvidiaKey) {
      RESULTS.skipped++;
      console.log('  ⏭️  SKIP: NVIDIA connection (no NVIDIA_API_KEY env var)');
      return;
    }
    const r = await fetchJSON('/api/settings/test-ai', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'nvidia',
        apiKey: nvidiaKey,
        model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      }),
    });
    assert(r.ok && r.body.ok === true, 'NVIDIA connection successful');
  });

  await test('GitHub PAT connection test (skipped if no PAT)', async () => {
    const ghPat = process.env.GH_PAT;
    if (!ghPat) {
      RESULTS.skipped++;
      console.log('  ⏭️  SKIP: GitHub connection (no GH_PAT env var)');
      return;
    }
    const r = await fetchJSON('/api/settings/test-github', {
      method: 'POST',
      body: JSON.stringify({
        githubPat: ghPat,
        githubRepo: 'Joshbond123/VEXA',
      }),
    });
    assert(r.ok && r.body.ok === true, 'GitHub connection successful');
    assert(r.body.permissions.admin === true, 'GitHub admin permission');
    assert(r.body.permissions.push === true, 'GitHub push permission');
    assert(r.body.permissions.pull === true, 'GitHub pull permission');
  });

  await test('Cloudflare connection test (invalid token returns error)', async () => {
    const r = await fetchJSON('/api/settings/test-cloudflare', {
      method: 'POST',
      body: JSON.stringify({
        cloudflareAccountId: 'f932764f168d0f77f74ae2b5c0c35c27',
        cloudflareApiToken: 'invalid-test-token',
      }),
    });
    assert(!r.ok && r.body.ok === false, 'Cloudflare rejects invalid token');
  });

  // ──────────────────────────────────────────────
  // 4. Emulator Routes
  // ──────────────────────────────────────────────
  console.log('\n─ Emulator API ─────────────────────────────────');

  await test('Emulator register rejects invalid token', async () => {
    const r = await fetchJSON('/api/emulator/register', {
      method: 'POST',
      body: JSON.stringify({
        deviceModel: 'Pixel 7',
        androidVersion: '14',
        resolution: '1080x2400',
        activeRunId: 'test-123',
        accessToken: 'invalid-token',
      }),
    });
    assert(!r.ok || r.body.error === 'Invalid emulator access token', 'Invalid token rejected');
  });

  await test('Emulator heartbeat without token returns error', async () => {
    const r = await fetchJSON('/api/emulator/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ status: 'online' }),
    });
    assert(!r.ok || r.body.error, 'Heartbeat requires auth');
  });

  // ──────────────────────────────────────────────
  // 5. Automations (Frontend)
  // ──────────────────────────────────────────────
  console.log('\n─ Automations API ──────────────────────────────');

  await test('GET automations returns array', async () => {
    const r = await fetchJSON('/api/frontend/automations');
    assert(r.ok, 'Automations GET ok');
    assert(Array.isArray(r.body.automations), 'Automations is array');
  });

  // ──────────────────────────────────────────────
  // 6. Agent Routes
  // ──────────────────────────────────────────────
  console.log('\n─ Agent API ────────────────────────────────────');

  await test('Agent routes exist', async () => {
    const r = await fetchJSON('/api/agent', { method: 'OPTIONS' });
    assert(r.status === 204 || r.ok, 'Agent OPTIONS responds');
  });

  // ──────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  E2E Test Results                              ║');
  console.log(`║  Passed: ${RESULTS.pass}   Failed: ${RESULTS.fail}   Skipped: ${RESULTS.skipped}   ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  process.exit(RESULTS.fail > 0 ? 1 : 0);
}

main();