import { b64decode, b64encode, now, sha256hex } from './util.js';

const SCHEMA = {
  kaggle_username: { env: 'KAGGLE_USER', default: '', label: 'Kaggle username' },
  kaggle_key: { env: 'KAGGLE_KEY', default: '', secret: true, label: 'Kaggle API key' },
  kaggle_dataset: { env: 'MODEL_DATASET', default: '', label: 'Model dataset' },
  kernel_slug: { env: 'KERNEL_SLUG', default: '', label: 'Runtime kernel' },
  model_served_id: { env: 'MODEL_SERVED_ID', default: 'qwen3.8-27b-uncensored-q6_k', label: 'Served model id' },
  model_file: { env: 'MODEL_FILE', default: '', label: 'Model file' },
  model_bytes: { env: 'MODEL_BYTES', default: '0', type: 'number', label: 'Model size (bytes)' },
  model_sha256: { env: 'MODEL_SHA256', default: '', label: 'Model SHA-256' },
  ctx_size: { env: 'CTX_SIZE', default: '32768', type: 'number', label: 'Context size' },
  parallel_slots: { env: 'PARALLEL_SLOTS', default: '2', type: 'number', label: 'Parallel slots' },
  idle_timeout_minutes: { env: 'IDLE_TIMEOUT_MINUTES', default: '20', type: 'number', label: 'Idle shutdown (minutes)' },
  auto_start: { default: 'true', type: 'bool', label: 'Auto-start GPU on request' },
  public_base_url: { env: 'PUBLIC_BASE_URL', default: '', label: 'Public base URL' },
  openhands_api_key: { default: '', secret: true, label: 'OpenHands cloud API key (optional)' },
  openhands_base_url: { default: 'https://app.all-hands.dev', label: 'OpenHands base URL' },
};

export const SETTING_KEYS = Object.keys(SCHEMA);

async function aesKey(env) {
  const secret = env.SECRET_KEY || 'vexa-development-key';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(env, plaintext) {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plaintext)));
  return `v1.${b64encode(iv)}.${b64encode(ct)}`;
}

export async function unseal(env, payload) {
  if (!payload) return null;
  const parts = String(payload).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const key = await aesKey(env);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(parts[1]) },
      key,
      b64decode(parts[2]),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

function coerce(meta, raw) {
  if (raw == null) return null;
  if (meta.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (meta.type === 'bool') return raw === true || raw === 'true' || raw === '1';
  return String(raw);
}

export async function readSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value, secret_enc, updated_at FROM settings').all();
  const map = new Map((results || []).map((r) => [r.key, r]));
  const values = {};
  const meta = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const row = map.get(key);
    let source = 'default';
    let value = spec.default;
    if (spec.secret) {
      const sealed = row?.secret_enc || (spec.env ? env[spec.env] : null);
      if (sealed) {
        const plain = await unseal(env, sealed);
        if (plain) {
          value = plain;
          source = row?.secret_enc ? 'database' : 'environment';
        } else if (spec.env && env[spec.env]) {
          // A sealed row that cannot be decrypted (rotated SECRET_KEY) must not mask the env secret.
          value = env[spec.env];
          source = 'environment';
        }
      }
      meta[key] = { set: !!value, source, label: spec.label, secret: true, updatedAt: row?.updated_at || null };
    } else {
      if (row && row.value != null) {
        value = row.value;
        source = 'database';
      } else if (spec.env && env[spec.env] != null) {
        value = env[spec.env];
        source = 'environment';
      }
      meta[key] = { source, label: spec.label, secret: false, updatedAt: row?.updated_at || null };
    }
    values[key] = coerce(spec, value);
  }
  return { values, meta };
}

export async function getSetting(env, key) {
  const spec = SCHEMA[key];
  if (!spec) throw new Error(`Unknown setting ${key}`);
  if (spec.secret) {
    const row = await env.DB.prepare('SELECT secret_enc FROM settings WHERE key = ?').bind(key).first();
    if (row?.secret_enc) {
      const plain = await unseal(env, row.secret_enc);
      if (plain) return plain;
    }
    return (spec.env && env[spec.env]) || '';
  }
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (row?.value != null) return coerce(spec, row.value);
  return coerce(spec, (spec.env && env[spec.env]) ?? spec.default);
}

export async function updateSettings(env, updates, operator = 'operator') {
  const applied = [];
  for (const [key, raw] of Object.entries(updates || {})) {
    const spec = SCHEMA[key];
    if (!spec) continue;
    if (raw === undefined) continue;
    if (spec.secret) {
      if (raw === '' || raw === null) continue; // never wipe a stored secret with a blank field
      await env.DB.prepare(
        `INSERT INTO settings (key, value, secret_enc, updated_at) VALUES (?, NULL, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = NULL, secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`,
      ).bind(key, await seal(env, String(raw)), now()).run();
      applied.push(key);
      continue;
    }
    let value = raw;
    if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${spec.label} must be a number`);
      value = String(n);
    } else if (spec.type === 'bool') {
      value = raw === true || raw === 'true' || raw === '1' ? 'true' : 'false';
    } else {
      value = String(raw);
    }
    await env.DB.prepare(
      `INSERT INTO settings (key, value, secret_enc, updated_at) VALUES (?, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret_enc = NULL, updated_at = excluded.updated_at`,
    ).bind(key, value, now()).run();
    applied.push(key);
  }
  if (applied.length) {
    await env.DB.prepare('INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)')
      .bind(now(), 'settings', `updated ${applied.length} setting(s)`, JSON.stringify({ keys: applied, operator })).run();
  }
  return applied;
}

export function publicSettings(values, meta) {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    out[key] = spec.secret ? { set: !!values[key], source: meta[key].source, label: spec.label, secret: true } : values[key];
  }
  return out;
}

export async function config(env) {
  const { values } = await readSettings(env);
  const base = values.public_base_url || env.PUBLIC_BASE_URL || '';
  return {
    kaggleUser: values.kaggle_username,
    kaggleKey: values.kaggle_key,
    dataset: values.kaggle_dataset,
    kernelSlug: values.kernel_slug,
    servedModel: values.model_served_id,
    modelFile: values.model_file,
    modelBytes: Number(values.model_bytes) || 0,
    modelSha256: values.model_sha256,
    ctx: Number(values.ctx_size) || 32768,
    parallel: Math.max(1, Math.min(4, Number(values.parallel_slots) || 2)),
    idleMinutes: Math.max(1, Number(values.idle_timeout_minutes) || 20),
    autoStart: values.auto_start !== false,
    baseUrl: base.replace(/\/+$/, ''),
  };
}

export { sha256hex };
