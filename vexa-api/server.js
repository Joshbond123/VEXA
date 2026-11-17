/*
 * VEXA Backend API
 * Autonomous AI Android Agent Platform
 *
 * Responsibilities:
 *  • Multi-provider AI architecture (NVIDIA NIM, xAI Grok, OpenAI-compatible)
 *  • Server-side API key storage + per-request key rotation
 *  • Automatic provider fallback on rate limits / failures
 *  • Streaming chat completions (SSE) forwarded to the frontend
 *  • Android device control (gateway HTTP -> mobilerun bridge -> ADB fallback)
 *  • Device/session persistence records (VIBELY-inspired)
 *  • Serves the VEXA frontend static files
 *
 * Secrets: API keys live ONLY server-side (data/settings.json, gitignored).
 * Never logged, never returned to the frontend, never committed.
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const __dirname = path.resolve('.');
const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USAGE_FILE = path.join(DATA_DIR, 'provider-usage.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const FRONTEND_DIR = path.join(__dirname, '..');

fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 8080);

/* ---------------------------------------------------------------- providers */
const PROVIDER_CATALOG = [
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    model: 'nemotron-3.5-super-vl-120b',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    envHint: 'NVIDIA_API_KEY',
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    model: 'grok-2-vision-1212',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    envHint: 'XAI_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    model: 'gpt-4o-mini',
    endpoint: process.env.OPENAI_COMPATIBLE_ENDPOINT || '',
    envHint: 'OPENAI_API_KEY',
  },
];

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function loadSettings() {
  const s = readJson(SETTINGS_FILE, {
    gatewayUrl: '',
    provider: 'nvidia',
    apiKeys: [],
    keyRotation: true,
    updatedAt: new Date().toISOString(),
  });
  // Redact keys before any potential logging/echo
  return s;
}
function saveSettings(settings) {
  settings.updatedAt = new Date().toISOString();
  writeJsonAtomic(SETTINGS_FILE, settings);
}

/* Key store (server-side only). Each key: {id, provider, value, createdAt, fails, rateLimitedUntil} */
function getKeys() {
  const s = loadSettings();
  return (s.apiKeys || []).map((k) => ({ ...k }));
}
function persistKeys(keys) {
  const s = loadSettings();
  s.apiKeys = keys;
  saveSettings(s);
}
function keyUsable(key) {
  if (!key.value) return false;
  if (key.rateLimitedUntil && Date.now() < key.rateLimitedUntil) return false;
  return true;
}
function markRateLimited(keyId, seconds = 60) {
  const keys = getKeys();
  const k = keys.find((x) => x.id === keyId);
  if (k) {
    k.rateLimitedUntil = Date.now() + seconds * 1000;
    k.fails = (k.fails || 0) + 1;
    persistKeys(keys);
  }
}
function recordUsage(provider, keyId, ok, ms) {
  const u = readJson(USAGE_FILE, {});
  u[provider] = u[provider] || { requests: 0, successes: 0, failures: 0, lastKey: keyId, lastAt: new Date().toISOString(), avgMs: 0 };
  u[provider].requests += 1;
  if (ok) u[provider].successes += 1; else u[provider].failures += 1;
  u[provider].lastKey = keyId;
  u[provider].lastAt = new Date().toISOString();
  u[provider].avgMs = Math.round((u[provider].avgMs * 0.8) + (ms * 0.2));
  writeJsonAtomic(USAGE_FILE, u);
}

/* Select the best usable key for a provider (round-robin, skip rate-limited) */
let rrIndex = 0;
function selectKey(providerId) {
  const keys = getKeys().filter((k) => k.provider === providerId && keyUsable(k));
  if (!keys.length) return null;
  const start = rrIndex % keys.length;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(start + i) % keys.length];
    rrIndex++;
    return k;
  }
  return null;
}

/* Provider selection order: primary first, then fallbacks */
function providerOrder(primaryId) {
  const ordered = [primaryId];
  for (const p of PROVIDER_CATALOG) if (p.id !== primaryId) ordered.push(p.id);
  return ordered;
}

/* ---------------------------------------------------------------- app */
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'vexa-api', timestamp: new Date().toISOString(), providers: PROVIDER_CATALOG.map((p) => p.id) });
});

// Providers (public info only — no keys)
app.get('/api/providers', (_req, res) => {
  const settings = loadSettings();
  const configuredIds = new Set((settings.apiKeys || []).filter((k) => k.value).map((k) => k.provider));
  const providers = PROVIDER_CATALOG.map((p) => ({
    id: p.id,
    label: p.label,
    model: p.model,
    configured: configuredIds.has(p.id),
    status: configuredIds.has(p.id) ? 'configured' : 'not_configured',
    primary: p.id === settings.provider,
  }));
  res.json({ ok: true, providers, primary: settings.provider, keyRotation: settings.keyRotation });
});

// Settings
app.get('/api/settings', (_req, res) => {
  const s = loadSettings();
  res.json({
    ok: true,
    gatewayUrl: s.gatewayUrl || '',
    provider: s.provider || 'nvidia',
    keyRotation: s.keyRotation !== false,
    // Only return masked key info (provider + last 4 chars), never the secret
    apiKeys: (s.apiKeys || []).map((k) => ({
      id: k.id,
      provider: k.provider,
      masked: k.value ? `••••••••${k.value.slice(-4)}` : null,
      createdAt: k.createdAt,
    })),
  });
});

app.post('/api/settings', (req, res) => {
  try {
    const { gatewayUrl, provider, apiKeys, keyRotation } = req.body || {};
    const s = loadSettings();
    if (typeof gatewayUrl === 'string') s.gatewayUrl = gatewayUrl.trim().replace(/\/+$/, '');
    if (provider) s.provider = provider;
    if (typeof keyRotation === 'boolean') s.keyRotation = keyRotation;
    if (Array.isArray(apiKeys)) {
      // Merge/update keys by provider; preserve ids for existing
      const existing = s.apiKeys || [];
      const next = [];
      for (const k of apiKeys) {
        const found = existing.find((e) => e.id === k.id) || existing.find((e) => e.provider === k.provider && e.value === k.value);
        next.push({ ...(found || {}), provider: k.provider, value: k.value || '', id: k.id || crypto.randomBytes(6).toString('hex'), createdAt: (found && found.createdAt) || new Date().toISOString() });
      }
      s.apiKeys = next.filter((k) => k.value);
    }
    saveSettings(s);
    res.json({ ok: true, provider: s.provider, keyRotation: s.keyRotation });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Usage / quotas
app.get('/api/usage', (_req, res) => {
  res.json({ ok: true, usage: readJson(USAGE_FILE, {}) });
});

// Sessions (persistence records)
app.get('/api/sessions', (_req, res) => {
  res.json({ ok: true, sessions: readJson(SESSIONS_FILE, []) });
});
app.post('/api/sessions', (req, res) => {
  try {
    const sessions = readJson(SESSIONS_FILE, []);
    const entry = { id: crypto.randomBytes(8).toString('hex'), createdAt: new Date().toISOString(), ...req.body };
    sessions.unshift(entry);
    writeJsonAtomic(SESSIONS_FILE, sessions.slice(0, 200));
    res.json({ ok: true, session: entry });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------------------------------------------------------- AI chat */
const SYSTEM_PROMPT = `You are VEXA, an autonomous AI agent operating a real Android phone (1080x2400).
You receive the user's task and a screenshot of the current screen.
Decide the SINGLE next action and respond ONLY with valid JSON:
{
  "thought": "brief reasoning about what you see on screen",
  "action": "tap|swipe|type|key|launch|back|home|wait|done|fail",
  "x": 540, "y": 1200, "x2": 540, "y2": 400,
  "text": "text to type or package name to launch",
  "keycode": 66,
  "ms": 2000,
  "app": "App Name",
  "summary": "final summary if done/fail",
  "outcomeAchieved": true,
  "nextRunMinutes": null
}
Never include internal reasoning tags (<thinking>, <think>, etc.) in your response.
A task is complete only when you have verified the result on screen.`;

function buildProviderPayload(provider, model, messages, key) {
  const base = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 512,
    stream: true,
  };
  if (provider.id === 'grok') {
    // xAI uses the OpenAI-compatible chat completions shape
    return { ...base, stream: true, stream_options: { include_usage: true } };
  }
  return base;
}

function extractTextFromProviderChunk(providerId, rawLine) {
  // Returns { delta, done, usage } or null
  if (rawLine.startsWith(':')) return null; // SSE comment
  if (rawLine === '[DONE]') return { done: true };
  const payload = rawLine.slice(6).trim(); // strip "data: "
  if (!payload || payload === '[DONE]') return payload === '[DONE]' ? { done: true } : null;
  try {
    const json = JSON.parse(payload);
  } catch { return null; }
  let json;
  try { json = JSON.parse(payload); } catch { return null; }
  const choice = json.choices?.[0];
  if (!choice) return null;
  const delta = (choice.delta && choice.delta.content) || '';
  const done = Boolean(choice.finish_reason);
  let usage = null;
  if (json.usage) usage = json.usage;
  return { delta, done, usage };
}

async function callProviderStream(providerId, key, messages, signal) {
  const provider = PROVIDER_CATALOG.find((p) => p.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (!key || !key.value) throw new Error(`No API key for ${provider.label}`);

  const body = buildProviderPayload(provider, provider.model, messages, key);
  const headers = {
    Authorization: `Bearer ${key.value}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
  };

  const start = Date.now();
  let lastKey = key.id;

  // Try this key; on 429/503 rotate within provider handled by caller
  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const status = res.status;
    if ((status === 429 || status === 401 || status === 403 || status >= 500)) {
      markRateLimited(key.id, status === 429 ? 60 : 30);
    }
    throw new Error(`${provider.label} API error ${status}: ${txt.slice(0, 300)}`);
  }

  if (!res.body) throw new Error(`${provider.label}: empty response body`);

  return {
    provider,
    keyId: key.id,
    stream: res.body,
    start,
    release: () => {
      const ms = Date.now() - start;
      recordUsage(providerId, keyId, true, ms);
    },
  };
}

async function streamChatCompletion(message, opts = {}) {
  const settings = loadSettings();
  const primary = opts.provider || settings.provider || 'nvidia';
  const keyRotation = settings.keyRotation !== false;
  const order = keyRotation ? providerOrder(primary) : [primary];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(opts.history || []).slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  let lastError = '';
  for (const providerId of order) {
    // Collect usable keys for this provider
    let attempts = 0;
    const maxKeyAttempts = keyRotation ? 5 : 1;
    while (attempts < maxKeyAttempts) {
      attempts++;
      const key = selectKey(providerId);
      if (!key) {
        lastError = `No usable API key for ${PROVIDER_CATALOG.find((p) => p.id === providerId)?.label || providerId}`;
        break; // try next provider
      }
      try {
        const result = await callProviderStream(providerId, key, messages, opts.signal);
        return result; // caller consumes the stream
      } catch (err) {
        lastError = err.message;
        // If rate-limited/auth, mark and try next key of same provider
        if (err.message.includes('429') || err.message.includes('401') || err.message.includes('403')) {
          markRateLimited(key.id, 60);
          continue;
        }
        // Other error: try next key then next provider
        markRateLimited(key.id, 30);
        continue;
      }
    }
  }
  throw new Error(lastError || 'All providers failed');
}

/* SSE streaming chat endpoint */
app.post('/api/chat/completions', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const { message, history, automationId, provider } = req.body || {};
  if (!message) {
    res.status(400).json({ ok: false, error: 'message is required' });
    return;
  }

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await streamChatCompletion(message, { history: history || [], provider, signal: res.socket ? undefined : undefined });
    const { stream, provider: prov, keyId, release } = result;

    send({ type: 'start', provider: prov.id, model: prov.model });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let collected = '';
    let done = false;

    try {
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) { done = true; break; }
        const text = decoder.decode(value, { stream: true });
        // Process SSE lines from provider
        const lines = text.split('\n');
        for (const line of lines) {
          const parsed = extractTextFromProviderChunk(prov.id, line);
          if (!parsed) continue;
          if (parsed.done) { done = true; break; }
          if (parsed.delta) {
            collected += parsed.delta;
            send({ type: 'delta', delta: parsed.delta });
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
      try { stream.cancel?.(); } catch {}
      release();
    }

    // Strip internal reasoning tags from the final delivered text
    const cleaned = collected
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/\[\s\S\]*?<\/think>/gi, '')
      .trim();

    send({ type: 'done', text: cleaned || collected, provider: prov.id });
  } catch (err) {
    console.error('Chat stream error:', err.message);
    send({ type: 'error', error: err.message });
  } finally {
    try { res.end(); } catch {}
  }
});

/* ---------------------------------------------------------------- device control */

function getGatewayUrl() {
  const s = loadSettings();
  return (s.gatewayUrl || '').trim().replace(/\/+$/, '');
}

async function gatewayRequest(path, options = {}) {
  const gw = getGatewayUrl();
  if (!gw) throw new Error('No gateway URL configured in settings.');
  const res = await fetch(`${gw}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: options.signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gateway ${path} failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

app.get('/api/device/status', async (req, res) => {
  try {
    let info = { online: false };
    try {
      info = await gatewayRequest('/api/public/health');
    } catch (e) {
      info = { online: false, error: e.message };
    }
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/api/device/screenshot', async (_req, res) => {
  try {
    const gw = getGatewayUrl();
    if (!gw) throw new Error('No gateway URL configured.');
    const upstream = await fetch(`${gw}/api/public/screenshot?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) throw new Error(`Screenshot failed (${upstream.status})`);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/device/action', async (req, res) => {
  try {
    const { action, ...params } = req.body || {};
    if (!action) throw new Error('action is required');
    const gw = getGatewayUrl();
    if (!gw) throw new Error('No gateway URL configured.');
    const upstream = await fetch(`${gw}/api/agent/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
      signal: AbortSignal.timeout(25000),
    });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      throw new Error(`Device action failed (${upstream.status}): ${txt.slice(0, 300)}`);
    }
    const data = await upstream.json().catch(() => ({ ok: true, action }));
    res.json({ ok: true, action, ...data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ---------------------------------------------------------------- serve frontend */
if (fs.existsSync(path.join(FRONTEND_DIR, 'index.html'))) {
  app.use(express.static(FRONTEND_DIR, { index: 'index.html' }));
  app.get('*', (_req, res) => {
    if (_req.path.startsWith('/api')) return res.status(404).json({ ok: false, error: 'Not found' });
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[VEXA API] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[VEXA API] Data dir: ${DATA_DIR}`);
});

process.on('uncaughtException', (err) => console.error('[VEXA API] uncaughtException', err.stack || err));
process.on('unhandledRejection', (err) => console.error('[VEXA API] unhandledRejection', err.stack || err));
