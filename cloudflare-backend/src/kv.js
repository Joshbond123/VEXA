/**
 * VEXA KV layer — every Workers KV write in the platform goes through here.
 *
 * Why this exists: the free Workers plan allows 1,000 KV writes per day, but the
 * emulator heartbeat wrote `emulator:default` every 30s — 2,880 writes/day on its
 * own — and the Durable Object wrote it again on every heartbeat. Once the cap
 * was hit every subsequent put() returned 429 and the mirrored state went stale.
 *
 * Three rules keep us far under the cap:
 *   1. A value identical to the last one written for that key is not written at
 *      all. State mirrors are mostly unchanged between beats, so this alone
 *      removes almost all of the traffic.
 *   2. Writes are throttled per key: at most one write per `minIntervalMs`.
 *      The freshest value is kept so the next allowed write is current.
 *   3. A 429 is retried with exponential backoff and then abandoned — never
 *      propagated as a request failure, because D1 is the source of truth and
 *      a missed KV mirror is a cache miss, not data loss.
 *
 * The mirror is only a cache. Anything that must not be lost lives in D1.
 */

/** Per-isolate memo of the last value written for each key. */
const lastWritten = new Map();
/** Per-isolate timestamp of the last write attempt for each key. */
const lastWriteAt = new Map();
/** Rolling write accounting for the diagnostics endpoint. */
const counters = {
  attempted: 0,
  written: 0,
  deduped: 0,
  throttled: 0,
  failed: 0,
  rateLimited: 0,
  lastError: '',
  lastWriteAt: 0,
  byKey: {},
};

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 250;

function keyStats(key) {
  if (!counters.byKey[key]) counters.byKey[key] = { written: 0, deduped: 0, throttled: 0, failed: 0 };
  return counters.byKey[key];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the error is a KV write-cap / rate-limit rejection. */
function isRateLimit(err) {
  const status = err?.status || err?.code;
  const text = String(err?.message || '');
  return status === 429 || status === 403 || /429|rate limit|daily.*limit|exceeded/i.test(text);
}

/**
 * Write a JSON value to KV, skipping the write when nothing changed.
 *
 * @param {KVNamespace} kv         KV binding (CONFIG_KV or SESSION_KV)
 * @param {string} key             key to write
 * @param {unknown} value          value to serialise
 * @param {object} [opts]
 * @param {number} [opts.expirationTtl]
 * @param {number} [opts.minIntervalMs] throttle window for this key
 * @param {boolean} [opts.force]   bypass dedupe/throttle (explicit user saves)
 * @returns {Promise<{ok: boolean, skipped?: 'dedupe'|'throttle'|'rate-limit'|'error', error?: string}>}
 */
export async function kvPutJson(kv, key, value, opts = {}) {
  if (!kv || typeof kv.put !== 'function') return { ok: false, skipped: 'error', error: 'KV binding unavailable' };

  const body = JSON.stringify(value);
  const stats = keyStats(key);
  counters.attempted += 1;

  if (!opts.force && lastWritten.get(key) === body) {
    counters.deduped += 1;
    stats.deduped += 1;
    return { ok: true, skipped: 'dedupe' };
  }

  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const previous = lastWriteAt.get(key) || 0;
  if (!opts.force && minInterval > 0 && Date.now() - previous < minInterval) {
    counters.throttled += 1;
    stats.throttled += 1;
    return { ok: true, skipped: 'throttle' };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const putOpts = {};
      if (opts.expirationTtl) putOpts.expirationTtl = opts.expirationTtl;
      await kv.put(key, body, putOpts);
      lastWritten.set(key, body);
      lastWriteAt.set(key, Date.now());
      counters.written += 1;
      counters.lastWriteAt = Date.now();
      stats.written += 1;
      return { ok: true };
    } catch (err) {
      if (isRateLimit(err)) {
        counters.rateLimited += 1;
        counters.failed += 1;
        counters.lastError = String(err?.message || err).slice(0, 200);
        stats.failed += 1;
        // The cap is daily, so retrying within the same request only burns
        // latency. Record it and let the caller carry on against D1.
        return { ok: false, skipped: 'rate-limit', error: counters.lastError };
      }
      if (attempt === MAX_RETRIES) {
        counters.failed += 1;
        counters.lastError = String(err?.message || err).slice(0, 200);
        stats.failed += 1;
        return { ok: false, skipped: 'error', error: counters.lastError };
      }
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }
  return { ok: false, skipped: 'error' };
}

/**
 * Read a JSON value from KV. Returns null when absent or unparseable — callers
 * treat KV as a cache and fall back to D1.
 */
export async function kvGetJson(kv, key) {
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Snapshot of KV write activity for the diagnostics endpoint. */
export function kvStats() {
  return {
    ...counters,
    byKey: { ...counters.byKey },
    note: 'Counters are per Worker isolate and reset on cold start; they show live write pressure, not the account-wide daily total.',
  };
}

/** Reset accounting — used by tests. */
export function resetKvStats() {
  counters.attempted = 0;
  counters.written = 0;
  counters.deduped = 0;
  counters.throttled = 0;
  counters.failed = 0;
  counters.rateLimited = 0;
  counters.lastError = '';
  counters.lastWriteAt = 0;
  counters.byKey = {};
  lastWritten.clear();
  lastWriteAt.clear();
}
