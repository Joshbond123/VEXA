import { GpuHub } from './coordinator.js';
import { handleAuth, hashPassword, requireOperator } from './auth.js';
import { config, publicSettings, readSettings, SETTING_KEYS, updateSettings } from './settings.js';
import * as kaggle from './kaggle.js';
import { buildKernel } from './kernel.js';
import { error, json, now, randomHex, readJson, sha256hex, timingSafeEqual, truncate } from './util.js';

export { GpuHub };

function hub(env) {
  // Durable Object instances keep running their original bundle until eviction, so the
  // instance name carries the deployment id. Every deploy gets fresh code, and the new
  // instance restores the session state from D1.
  const version = (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || 'dev';
  return env.GPU.get(env.GPU.idFromName(`vexa-gpu-${version}`));
}

// Every call here is one billed Durable Object request. The free plan allows 100k/day
// and fails every call once spent, so remember the outage: retrying clients must not
// keep hammering the hub, and a single probe every few minutes re-opens after an upgrade.
const QUOTA_PROBE_MS = 5 * 60 * 1000;
let quotaBlockedUntil = 0;
let quotaProbeAfter = 0;

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function isQuotaError(text) {
  return /durable objects free tier|exceeded allowed volume/i.test(String(text || ''));
}

function quotaError() {
  if (!quotaBlockedUntil) quotaBlockedUntil = nextUtcMidnight();
  return Object.assign(new Error(
    'GPU control plane unavailable: the Durable Objects free-tier daily quota is exhausted. '
    + 'It resets at 00:00 UTC; upgrading the Cloudflare plan removes the cap. '
    + 'A running direct kernel serves requests without the relay, so start one on Kaggle.',
  ), { status: 503, retryAt: quotaBlockedUntil, quota: true });
}

const CLIENT_ERRORS = { 'Invalid JSON body': 400, 'Request body too large': 413 };

function gatewayError(err) {
  const status = Number(err && err.status) || CLIENT_ERRORS[err && err.message] || 500;
  const message = (err && err.message) || 'Worker error';
  const type = status === 503 ? 'service_unavailable' : status < 500 ? 'invalid_request_error' : 'server_error';
  const body = { error: { message, type } };
  const headers = { 'cache-control': 'no-store' };
  if (err && err.retryAt) {
    body.error.retry_after = new Date(err.retryAt).toISOString();
    headers['retry-after'] = String(Math.max(1, Math.ceil((err.retryAt - now()) / 1000)));
  }
  console.error(message, (err && err.stack) || '');
  return json(body, { status, headers });
}

async function gpu(env, path, body = {}, method = 'POST') {
  if (quotaBlockedUntil > now() && now() < quotaProbeAfter) throw quotaError();
  let res;
  try {
    res = await hub(env).fetch(`https://hub${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (isQuotaError(err && err.message)) {
      quotaProbeAfter = now() + QUOTA_PROBE_MS;
      throw quotaError();
    }
    throw err;
  }
  const text = await res.text();
  if (isQuotaError(text)) {
    quotaProbeAfter = now() + QUOTA_PROBE_MS;
    throw quotaError();
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error(`GPU hub returned a non-JSON response (HTTP ${res.status})`), { status: 502 });
  }
  quotaBlockedUntil = 0;
  return data;
}

// The Worker builds the kernel source so a long-lived Durable Object can never
// push a stale copy of runtime/vexa_runtime.py.
async function startGpu(env, reason) {
  const cfg = await config(env);
  const nonce = randomHex(16);
  const source = buildKernel({ ...cfg, runtimeKey: env.INTERNAL_RUNTIME_KEY, sessionNonce: nonce });
  return gpu(env, '/ensure', { reason, nonce, source });
}

async function apiKeyRow(env, request) {
  const header = request.headers.get('authorization') || '';
  const key = (header.replace(/^Bearer\s+/i, '').trim() || request.headers.get('x-api-key') || '').trim();
  if (!key) return { key: null, row: null };
  const row = await env.DB.prepare(
    'SELECT id, name, key_prefix, revoked_at FROM api_keys WHERE key_hash = ?',
  ).bind(await sha256hex(key)).first();
  return { key, row: row && !row.revoked_at ? row : null };
}

function bearer(request) {
  const header = request.headers.get('authorization') || '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/direct' || path === '/api/direct/announce') return await directRoute(request, env);
      if (path.startsWith('/api/runtime/')) return await runtimeRoute(request, env, path);
      if (path === '/api/model-test' && request.method === 'POST') return await modelTest(request, env);
      if (path.startsWith('/direct/v1/')) return await directProxy(request, env, path);
      if (path === '/v1/models' || path === '/v1/chat/completions') return await openaiRoute(request, env, path);
      if (path.startsWith('/api/')) return await apiRoute(request, env, path, url);
      return await env.ASSETS.fetch(request);
    } catch (err) {
      return gatewayError(err);
    }
  },
};

// A direct kernel has no session and therefore no Durable Object. It announces the
// public URL of its tunnel here instead, which costs one D1 write and nothing else.
async function directRoute(request, env) {
  const key = env.DIRECT_ANNOUNCE_KEY;
  if (!key) return error('Direct endpoint reporting is not configured', 503);
  if (request.headers.get('x-runtime-key') !== key) return error('Forbidden', 403);
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      "SELECT message, detail, ts FROM events WHERE kind = 'direct-endpoint' ORDER BY ts DESC LIMIT 1",
    ).first();
    if (!row) return json({ endpoint: null });
    return json({ endpoint: { url: row.message, detail: row.detail, ts: row.ts } });
  }
  const body = await readJson(request);
  const target = String(body.url || '').trim();
  if (!/^https:\/\/[^\s]+$/.test(target)) return error('A public https url is required', 400);
  await env.DB.prepare('INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)')
    .bind(now(), 'direct-endpoint', target, JSON.stringify({ model: body.model || null, kernelRef: body.kernelRef || null }))
    .run();
  return json({ ok: true, url: target });
}

async function apiRoute(request, env, path, url) {
  if (path === '/api/health') return json({ ok: true, ts: now(), service: 'vexa' });
  const handled = await handleAuth(request, env, path);
  if (handled) return handled;
  const { op, response } = await requireOperator(env, request);
  if (!op) return response;
  try {
    if (path === '/api/overview' && request.method === 'GET') return json(await overview(env, op));
    if (path === '/api/gpu' && request.method === 'GET') return json(await gpu(env, '/state', {}, 'GET'));
    if (path === '/api/gpu/logs' && request.method === 'GET') return json(await gpu(env, '/logs', {}, 'GET'));
    if (path === '/api/gpu/start' && request.method === 'POST') return json(await startGpu(env, op.username || 'dashboard'));
    if (path === '/api/gpu/stop' && request.method === 'POST') {
      const body = await readJson(request);
      return json(await gpu(env, '/stop', { reason: String(body.reason || 'dashboard') }));
    }
    if (path === '/api/gpu/hold' && request.method === 'POST') {
      const body = await readJson(request);
      return json(await gpu(env, '/hold', { minutes: Number(body.minutes) || 0 }));
    }
    if (path === '/api/settings' && request.method === 'GET') {
      const { values, meta } = await readSettings(env);
      return json({ settings: publicSettings(values, meta), keys: SETTING_KEYS });
    }
    if (path === '/api/settings' && request.method === 'PUT') {
      const body = await readJson(request);
      const applied = await updateSettings(env, body.settings || body, op.username);
      const { values, meta } = await readSettings(env);
      return json({ ok: true, applied, settings: publicSettings(values, meta) });
    }
    if (path === '/api/kaggle' && request.method === 'GET') {
      const cfg = await config(env);
      const result = await kaggle.validate(cfg);
      return json(result);
    }
    if (path === '/api/dataset' && request.method === 'GET') {
      const cfg = await config(env);
      const [info, files] = await Promise.all([
        kaggle.datasetInfo(cfg).catch((err) => ({ exists: false, error: err.message })),
        kaggle.datasetFiles(cfg).catch(() => []),
      ]);
      return json({ info, files });
    }
    if (path === '/api/keys' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, name, key_prefix, created_at, last_used_at, revoked_at, requests FROM api_keys ORDER BY created_at DESC',
      ).all();
      return json({ keys: results || [] });
    }
    if (path === '/api/keys' && request.method === 'POST') {
      const body = await readJson(request);
      const name = String(body.name || 'API key').trim().slice(0, 60) || 'API key';
      const raw = 'vx-' + randomHex(24);
      const prefix = raw.slice(0, 10);
      const id = 'key_' + randomHex(6);
      await env.DB.prepare(
        'INSERT INTO api_keys (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(id, name, prefix, await sha256hex(raw), now()).run();
      return json({ ok: true, key: raw, id, name, prefix });
    }
    if (path === '/api/keys/revoke' && request.method === 'POST') {
      const body = await readJson(request);
      await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').bind(now(), String(body.id || '')).run();
      return json({ ok: true });
    }
    if (path === '/api/events' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT ts, kind, message, detail FROM events ORDER BY ts DESC LIMIT 200',
      ).all();
      return json({ events: results || [] });
    }
    if (path === '/api/sessions' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, kernel_version, status, started_at, ready_at, ended_at, end_reason FROM gpu_sessions ORDER BY started_at DESC LIMIT 50',
      ).all();
      return json({ sessions: results || [] });
    }
    if (path === '/api/requests' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT ts, job_id, key_id, status, prompt_tokens, completion_tokens, latency_ms FROM requests ORDER BY ts DESC LIMIT 100',
      ).all();
      return json({ requests: results || [] });
    }
    return error('Not found', 404);
  } catch (err) {
    if (err instanceof kaggle.KaggleError) return error(err.message, err.status === 401 ? 400 : 502, { kaggle: true });
    return gatewayError(err.status ? err : Object.assign(err, { status: 500 }));
  }
}

async function overview(env, op) {
  const cfg = await config(env);
  const { values, meta } = await readSettings(env);
  const [state, quota, dataset, kernel] = await Promise.all([
    gpu(env, '/state', {}, 'GET').catch(() => null),
    kaggle.quota(cfg).catch((err) => ({ error: err.message })),
    kaggle.datasetInfo(cfg).catch((err) => ({ exists: false, error: err.message })),
    kaggle.kernelInfo(cfg).catch((err) => ({ exists: false, error: err.message })),
  ]);
  const since = now() - 7 * 86400000;
  let usageSeconds = 0;
  try {
    const { results } = await env.DB.prepare(
      'SELECT started_at, ended_at FROM gpu_sessions WHERE started_at > ?',
    ).bind(since).all();
    for (const row of results || []) {
      const end = Math.min(row.ended_at || now(), now());
      usageSeconds += Math.max(0, (end - row.started_at) / 1000);
    }
  } catch {}
  const { results: recent } = await env.DB.prepare(
    'SELECT ts, kind, message FROM events ORDER BY ts DESC LIMIT 12',
  ).all().catch(() => ({ results: [] }));
  return {
    operator: { username: op.username, role: op.role },
    gpu: state,
    quota,
    dataset,
    kernel,
    settings: publicSettings(values, meta),
    usage: {
      weeklySeconds: Math.round(usageSeconds),
      weeklyHours: Math.round(usageSeconds / 360) / 10,
      remainingSeconds: quota?.gpu ? Math.max(0, quota.gpu.totalSeconds - quota.gpu.usedSeconds - quota.gpu.reservedSeconds) : null,
    },
    events: recent || [],
    direct: await freshDirectEndpoint(env)
      .then((url) => (url ? { url, host: new URL(url).host } : null))
      .catch(() => null),
  };
}

async function runtimeRoute(request, env, path) {
  const url = new URL(request.url);
  const sub = path.slice('/api/runtime'.length);
  if (sub === '/register') {
    const key = request.headers.get('x-runtime-key') || '';
    if (!env.INTERNAL_RUNTIME_KEY || !timingSafeEqual(key, env.INTERNAL_RUNTIME_KEY)) {
      return error('Forbidden', 403);
    }
    const body = await readJson(request);
    return json(await gpu(env, '/register', body));
  }
  const token = bearer(request);
  if (!token) return error('Runtime token required', 401);
  const forward = async (target, body, method = 'POST') => {
    const res = await hub(env).fetch(`https://hub${target}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  if (sub === '/poll') {
    const slot = url.searchParams.get('slot') || '0';
    const wait = url.searchParams.get('wait') || '0';
    return forward(`/poll?slot=${encodeURIComponent(slot)}&wait=${encodeURIComponent(wait)}`, null, 'GET');
  }
  if (sub === '/heartbeat' || sub === '/phase' || sub === '/log' || sub === '/stopped' || sub === '/error') {
    const body = await readJson(request);
    return forward(sub === '/error' ? '/runtimeerror' : sub, body);
  }
  const match = sub.match(/^\/jobs\/([A-Za-z0-9_]+)\/(chunk|done|error)$/);
  if (match) {
    const body = await readJson(request);
    body.job = match[1];
    return forward(match[2] === 'error' ? '/joberror' : `/${match[2]}`, body);
  }
  return error('Not found', 404);
}

const DONE = "[" + "DONE" + "]";
const WARM_TIMEOUT_MS = 16 * 60 * 1000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

function sse(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function litellmModelId(served) {
  return /^[a-z0-9_-]+\//i.test(served) ? served : `openai/${served}`;
}

function apiError(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, code } };
}

async function waitForGpu(env, state, deadline) {
  let current = state;
  while (current && current.status !== 'ready' && current.status !== 'busy') {
    if (!current || current.status === 'error' || current.status === 'off') {
      throw Object.assign(new Error(current?.error || 'GPU is not available'), { status: 503 });
    }
    if (now() > deadline) throw Object.assign(new Error('GPU did not become ready in time'), { status: 504 });
    current = await gpu(env, '/waitready', { timeout: 20000 });
  }
  return current;
}

// The permanent front door: the tunnel URL changes on every kernel start, this does
// not. Requests are proxied straight to the announced tunnel, so no Durable Object is
// involved and the model key never leaves the Worker.
const DIRECT_STALE_MS = 30 * 60 * 1000;

async function freshDirectEndpoint(env) {
  if (!env.DIRECT_MODEL_KEY) return null;
  const row = await env.DB.prepare(
    "SELECT message, ts FROM events WHERE kind = 'direct-endpoint' ORDER BY ts DESC LIMIT 1",
  ).first();
  if (!row || now() - row.ts > DIRECT_STALE_MS) return null;
  return row.message.replace(/\/+$/, '');
}

// A kernel can stop announcing while its tunnel still answers (a dead announce
// thread, a slow D1 write). Trust a tunnel that responds rather than falling back
// to a relay that may have no quota left.
async function configuredBaseUrl(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").first();
    const value = String((row && row.value) || '').trim();
    if (/^https:\/\//.test(value)) return value.replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch {}
  return null;
}

async function resolveDirectEndpoint(env) {
  const configured = await configuredBaseUrl(env);
  if (configured) return configured;
  const fresh = await freshDirectEndpoint(env);
  if (fresh) return fresh;
  if (!env.DIRECT_MODEL_KEY) return null;
  const row = await env.DB.prepare(
    "SELECT message FROM events WHERE kind = 'direct-endpoint' ORDER BY ts DESC LIMIT 1",
  ).first();
  if (!row) return null;
  const url = row.message.replace(/\/+$/, '');
  try {
    const res = await fetch(url + '/v1/models', {
      headers: { authorization: `Bearer ${env.DIRECT_MODEL_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

async function modelTest(request, env) {
  // A key or a dashboard session: this call spends GPU, so it is never anonymous.
  const keyed = await apiKeyRow(env, request);
  if (!keyed.row) {
    const { op, response } = await requireOperator(env, request);
    if (!op) return response;
  }
  const base = await resolveDirectEndpoint(env);
  if (!base) {
    return json({ ok: false, engine: 'none', error: 'No GPU kernel is reporting. Start the direct kernel on Kaggle.' });
  }
  const started = now();
  try {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DIRECT_MODEL_KEY}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
        max_tokens: 160,
        temperature: 0,
      }),
    });
    const text = await res.text();
    const ms = now() - started;
    if (!res.ok) {
      return json({ ok: false, engine: 'direct', host: new URL(base).host, status: res.status, error: text.slice(0, 300), ms });
    }
    const data = JSON.parse(text);
    const message = data.choices?.[0]?.message || {};
    return json({
      ok: true,
      engine: 'direct',
      host: new URL(base).host,
      ms,
      model: data.model,
      reply: (message.content || message.reasoning_content || '').trim().slice(0, 120),
    });
  } catch (err) {
    return json({ ok: false, engine: 'direct', error: String((err && err.message) || err).slice(0, 300), ms: now() - started });
  }
}

async function logInference(env, engine, status, ms, extra = {}) {
  try {
    await env.DB.prepare('INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)')
      .bind(now(), 'inference', `${engine}:${status}`, JSON.stringify({ ms, ...extra }))
      .run();
  } catch { /* logging must never break inference */ }
}

async function proxyDirect(env, upstreamPath, bodyText, contentType) {
  const base = await resolveDirectEndpoint(env);
  if (!base) return null;
  const started = now();
  const upstream = await fetch(base + upstreamPath, {
    method: bodyText === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': contentType || 'application/json',
      authorization: `Bearer ${env.DIRECT_MODEL_KEY}`,
    },
    body: bodyText,
  });
  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') || 'application/json');
  headers.set('cache-control', 'no-store');
  headers.set('x-vexa-direct', new URL(base).host);
  await logInference(env, 'direct', upstream.status, now() - started, { path: upstreamPath, host: new URL(base).host });
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function directProxy(request, env, path) {
  const { row } = await apiKeyRow(env, request);
  if (!row) return error('Invalid API key', 401);
  if (!env.DIRECT_MODEL_KEY) return error('Direct proxying is not configured', 503);
  const text = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  const res = await proxyDirect(env, path.replace(/^\/direct/, ''), text, request.headers.get('content-type'));
  return res || error('No direct kernel is reporting right now', 503);
}

async function openaiRoute(request, env, path) {
  const { row } = await apiKeyRow(env, request);
  if (!row) return error('Invalid API key', 401);
  const cfg = await config(env);
  if (path === '/v1/models') {
    // LiteLLM (and therefore OpenHands) refuses a model id without a provider prefix,
    // so advertise the prefixed id first and keep the bare one for plain OpenAI clients.
    const created = Math.floor(now() / 1000);
    return json({
      object: 'list',
      data: [litellmModelId(cfg.servedModel), cfg.servedModel].map((id) => ({ id, object: 'model', created, owned_by: 'vexa' })),
    });
  }
  if (request.method !== 'POST') return error('Method not allowed', 405);
  const body = await readJson(request);
  if (!Array.isArray(body.messages) || body.messages.length === 0) return error('messages[] is required');
  // Reject oversized prompts up front: prefill is expensive, and each GPU slot only
  // holds ctx/parallel tokens. ~3 chars per token is a safe floor for code-heavy prompts.
  const slotChars = Math.floor((Number(cfg.ctx) || 32768) / (Number(cfg.parallel) || 2)) * 3;
  const maxChars = Math.min(520000, slotChars);
  const promptChars = JSON.stringify(body.messages).length;
  if (promptChars > maxChars) {
    return error(`Prompt is too large: ${promptChars} chars, limit ${maxChars} for the current context window`, 413);
  }
  const stream = !!body.stream;
  // One model per deployment: "x", "openai/x" and any alias all resolve to it.
  const payload = { ...body, model: cfg.servedModel };
  if (payload.max_tokens == null && payload.max_completion_tokens == null) payload.max_tokens = 4096;
  delete payload.max_completion_tokens;
  // The relay spends a Durable Object request per flush, which a free plan cannot
  // sustain. When a direct kernel is reporting, answer from it and leave the relay idle.
  const direct = await proxyDirect(env, path, JSON.stringify(payload), 'application/json');
  if (direct) return direct;
  await logInference(env, 'relay', 'routed', 0, { path });
  let state = await gpu(env, '/state', {}, 'GET');
  try {
    if (!state || state.status === 'off' || state.status === 'error') {
      if (!cfg.autoStart) throw Object.assign(new Error('GPU is off. Start it from the console first.'), { status: 503 });
      state = await startGpu(env, `api:${row.name}`);
    }
    state = await waitForGpu(env, state, now() + WARM_TIMEOUT_MS);
  } catch (err) {
    return gatewayError(Object.assign(err, { status: err.status || 503 }));
  }
  const job = await gpu(env, '/enqueue', {
    body: payload, stream, keyId: row.id, promptChars: JSON.stringify(body.messages).length,
  });
  if (stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    (async () => {
      let cursor = 0;
      const started = now();
      try {
        for (;;) {
          if (request.signal.aborted) break;
          if (now() - started > JOB_TIMEOUT_MS) {
            gpu(env, '/cancel', { job: job.id }).catch(() => {});
            await writer.write(encoder.encode(sse(apiError('Generation timed out', 'upstream_timeout'))));
            break;
          }
          await writer.write(encoder.encode(': ping\n\n'));
          const res = await gpu(env, `/wait?job=${job.id}&cursor=${cursor}&timeout=25000`, {}, 'GET');
          if (res.missing) {
            await writer.write(encoder.encode(sse(apiError('Job was lost', 'server_error'))));
            break;
          }
          for (const chunk of res.chunks || []) {
            await writer.write(encoder.encode(`data: ${chunk}\n\n`));
          }
          cursor = res.cursor ?? cursor;
          if (res.done) {
            if (res.error) await writer.write(encoder.encode(sse(apiError(res.error, "upstream_error"))));
            await writer.write(encoder.encode(sse(DONE)));
            break;
          }
        }
      } catch (err) {
        try { await writer.write(encoder.encode(sse(apiError(err.message || "stream failed")))); } catch {}
      } finally {
        try { await writer.close(); } catch {}
      }
    })();
    request.signal.addEventListener("abort", () => { gpu(env, "/cancel", { job: job.id }).catch(() => {}); });
    return new Response(readable, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
    });
  }
  const started = now();
  let cursor = 0;
  for (;;) {
    if (now() - started > JOB_TIMEOUT_MS) return error("Generation timed out", 504);
    const res = await gpu(env, `/wait?job=${job.id}&cursor=${cursor}&timeout=25000`, {}, "GET");
    if (res.missing) return error("Job was lost", 500);
    cursor = res.cursor ?? cursor;
    if (res.done) {
      if (res.error) {
        // A prompt larger than the slot window is a client error, not a gateway fault.
        const overflow = /exceeds the available context|context size/i.test(String(res.error));
        return error(res.error, overflow ? 400 : 502);
      }
      if (!res.result) return error("GPU returned an empty response", 502);
      return json(res.result);
    }
  }
}

export { GpuHub as Coordinator };
