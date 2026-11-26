import { buildKernel } from './kernel.js';
import * as kaggle from './kaggle.js';
import { config } from './settings.js';
import { now, randomHex, sha256hex, timingSafeEqual, truncate } from './util.js';

const LIVE = new Set(['starting', 'loading', 'ready', 'busy']);
const STARTUP_TIMEOUT_MS = 20 * 60 * 1000;
const HEARTBEAT_STALE_MS = 150 * 1000;
const STOP_TIMEOUT_MS = 150 * 1000;

function blankState() {
  return {
    status: 'off', phase: 'off', detail: 'GPU is off', sessionId: null, kernelVersion: 0,
    startedAt: null, allocatedAt: null, readyAt: null, lastHeartbeat: null, lastActivity: null,
    activeJobs: 0, progress: 0, gpus: [], model: null, metrics: null, error: null,
    stopRequested: false, stopReason: null, stopAt: null, holdUntil: 0, nonce: null,
    runtimeHash: null, logTail: [], updatedAt: now(),
  };
}

function publicState(s) {
  return {
    status: s.status, phase: s.phase, detail: s.detail, sessionId: s.sessionId,
    kernelVersion: s.kernelVersion, startedAt: s.startedAt, allocatedAt: s.allocatedAt,
    readyAt: s.readyAt, lastHeartbeat: s.lastHeartbeat, lastActivity: s.lastActivity,
    activeJobs: s.activeJobs, progress: Math.round((Number(s.progress) || 0) * 100), gpus: s.gpus, model: s.model,
    metrics: s.metrics, error: s.error, stopRequested: s.stopRequested, stopReason: s.stopReason,
    holdUntil: s.holdUntil, updatedAt: s.updatedAt,
  };
}

export class GpuHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.jobs = new Map();
    this.waiters = new Map();
    this.s = null;
  }

  async load() {
    if (this.s) return this.s;
    const stored = await this.storage.get('state');
    if (stored) {
      this.s = stored;
      return this.s;
    }
    // A new instance (new deploy) starts empty: rebuild from D1 so a live GPU
    // session and its runtime token survive the rollout.
    try {
      const row = await this.env.DB.prepare('SELECT state_json FROM gpu_state WHERE id = 1').first();
      if (row && row.state_json) this.s = { ...blankState(), ...JSON.parse(row.state_json) };
    } catch {}
    if (!this.s) this.s = blankState();
    await this.storage.put('state', this.s);
    return this.s;
  }

  async save() {
    this.s.updatedAt = now();
    await this.storage.put('state', this.s);
    this.persistD1();
  }

  async persistD1() {
    const s = this.s;
    try {
      await this.env.DB.prepare(
        `INSERT INTO gpu_state (id, status, phase, detail, session_id, kernel_version, started_at,
           allocated_at, ready_at, last_heartbeat, last_activity, active_jobs, progress, gpus_json,
           model_json, error, stop_reason, updated_at, state_json)
         VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, phase=excluded.phase, detail=excluded.detail,
           session_id=excluded.session_id, kernel_version=excluded.kernel_version, started_at=excluded.started_at,
           allocated_at=excluded.allocated_at, ready_at=excluded.ready_at, last_heartbeat=excluded.last_heartbeat,
           last_activity=excluded.last_activity, active_jobs=excluded.active_jobs, progress=excluded.progress,
           gpus_json=excluded.gpus_json, model_json=excluded.model_json, error=excluded.error,
           stop_reason=excluded.stop_reason, updated_at=excluded.updated_at, state_json=excluded.state_json`,
      ).bind(s.status, s.phase, s.detail, s.sessionId, s.kernelVersion, s.startedAt, s.allocatedAt,
        s.readyAt, s.lastHeartbeat, s.lastActivity, s.activeJobs, s.progress,
        JSON.stringify(s.gpus || []), JSON.stringify(s.model || null), s.error, s.stopReason, s.updatedAt,
        JSON.stringify(s)).run();
    } catch {}
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }

  async runtimeOk(request) {
    const header = request.headers.get('authorization') || '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || !this.s.runtimeHash) return false;
    return timingSafeEqual(await sha256hex(token), this.s.runtimeHash);
  }

  async waitReady(ms) {
    const end = now() + Math.max(1000, Math.min(25000, ms || 20000));
    for (;;) {
      const s = await this.storage.get('state');
      if (s) this.s = s;
      const status = this.s.status;
      if (status === 'ready' || status === 'busy' || status === 'error' || status === 'off') return publicState(this.s);
      if (now() >= end) return publicState(this.s);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Alarms are best-effort; heal deadline overruns whenever the object is touched.
  async heal() {
    const s = this.s;
    const t = now();
    if (s.status === 'stopping' && t - (s.stopAt || t) > STOP_TIMEOUT_MS) return this.finalizeOff(s.stopReason || 'stop');
    if (s.status === 'starting' && t - (s.startedAt || t) > STARTUP_TIMEOUT_MS) return this.failSession('GPU startup timed out after 20 minutes');
    if ((s.status === 'starting' || s.status === 'loading') && s.allocatedAt && s.lastHeartbeat && t - s.lastHeartbeat > HEARTBEAT_STALE_MS) {
      return this.failSession('Lost contact with the GPU runtime');
    }
    return null;
  }

  async fetch(request) {
    await this.load();
    await this.heal();
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
    const guarded = new Set(['/heartbeat', '/phase', '/log', '/stopped', '/runtimeerror', '/poll', '/chunk', '/done', '/joberror']);
    if (guarded.has(path) && !(await this.runtimeOk(request))) return this.json({ error: 'runtime token rejected' }, 401);
    switch (path) {
      case '/state': return this.json(publicState(this.s));
      case '/logs': return this.json({ lines: this.s.logTail || [] });
      case '/waitready': return this.json(await this.waitReady(Number(url.searchParams.get('timeout') || 20000)));
      case '/ensure': return this.json(await this.ensure(body));
      case '/stop': return this.json(await this.stop(body.reason || 'manual'));
      case '/hold': return this.json(await this.hold(body.minutes));
      case '/enqueue': return this.json(await this.enqueue(body));
      case '/wait': return this.json(await this.waitJob(url.searchParams.get('job'), Number(url.searchParams.get('cursor') || 0), Number(url.searchParams.get('timeout') || 15000)));
      case '/chunk': return this.json(await this.chunk(body));
      case '/done': return this.json(await this.done(body));
      case '/joberror': return this.json(await this.jobError(body));
      case '/cancel': return this.json(await this.cancel(body.job));
      case '/register': return this.json(await this.register(body));
      case '/heartbeat': return this.json(await this.heartbeat(body));
      case '/phase': return this.json(await this.phase(body));
      case '/log': return this.json(await this.log(body));
      case '/stopped': return this.json(await this.stopped(body));
      case '/runtimeerror': return this.json(await this.runtimeError(body));
      case '/poll': return this.json(await this.poll(url.searchParams.get('slot')));
      default: return this.json({ error: 'unknown coordinator route' }, 404);
    }
  }

  async fail(stage, err) {
    const s = this.s;
    s.status = 'error';
    s.phase = 'error';
    s.error = truncate(err?.message || String(err), 600);
    s.detail = stage === 'start' ? 'Kaggle GPU start failed' : s.error;
    s.activeJobs = 0;
    await this.save();
    await this.log({ lines: [{ ts: now(), level: 'error', message: `[${stage}] ${s.error}` }] });
    await this.closeSession('error', s.error);
    await this.state.storage.deleteAlarm();
    return publicState(s);
  }

  async ensure(body = {}) {
    const reason = typeof body === 'string' ? body : body.reason || 'request';
    const s = this.s;
    if (LIVE.has(s.status) || s.status === 'stopping') return publicState(s);
    const cfg = await config(this.env);
    if (!cfg.kaggleKey) return this.fail('start', new Error('Kaggle API key is not configured'));
    if (!cfg.dataset) return this.fail('start', new Error('Model dataset is not configured'));
    Object.assign(s, {
      status: 'starting', phase: 'queued', detail: `Starting GPU (${reason})`, error: null,
      startedAt: now(), allocatedAt: null, readyAt: null, progress: 0, gpus: [], model: null,
      metrics: null, stopRequested: false, stopReason: null, stopAt: null, activeJobs: 0,
      // A cold start takes minutes; a leftover timestamp from the last session made the
      // heartbeat watchdog kill brand-new sessions before their kernel could register.
      lastHeartbeat: null, logTail: [], kernelVersion: null, sawRunning: false,
      nonce: body.nonce || randomHex(16), runtimeHash: null, sessionId: 'gs_' + randomHex(6),
    });
    await this.save();
    try {
      const q = await kaggle.quota(cfg);
      const left = q.gpu.totalSeconds - q.gpu.usedSeconds - q.gpu.reservedSeconds;
      if (q.gpu.totalSeconds > 0 && left <= 120) {
        return this.fail('start', new Error(`Kaggle GPU quota exhausted (${Math.max(0, left)}s remaining until ${q.refreshAt || 'reset'})`));
      }
      const source = body.source || buildKernel({ ...cfg, runtimeKey: this.env.INTERNAL_RUNTIME_KEY, sessionNonce: s.nonce });
      const pushed = await kaggle.pushKernel(cfg, source);
      s.kernelVersion = pushed.version;
      s.detail = 'Kaggle kernel queued; waiting for GPU allocation';
      await this.save();
      await this.openSession();
      await this.state.storage.setAlarm(now() + 8000);
      return publicState(s);
    } catch (err) {
      return this.fail('start', err);
    }
  }

  async openSession() {
    const s = this.s;
    try {
      await this.env.DB.prepare(
        'INSERT INTO gpu_sessions (id, kernel_version, status, started_at, gpu_count) VALUES (?, ?, ?, ?, 0)',
      ).bind(s.sessionId, s.kernelVersion, 'starting', s.startedAt).run();
    } catch {}
    try {
      await this.env.DB.prepare('INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)')
        .bind(now(), 'gpu', `started GPU session ${s.sessionId}`, JSON.stringify({ kernelVersion: s.kernelVersion })).run();
    } catch {}
  }

  async closeSession(status, reason) {
    const s = this.s;
    try {
      await this.env.DB.prepare(
        'UPDATE gpu_sessions SET status = ?, ended_at = ?, end_reason = ?, ready_at = ? WHERE id = ?',
      ).bind(status, now(), reason || null, s.readyAt || null, s.sessionId).run();
    } catch {}
  }

  async stop(reason = 'manual') {
    const s = this.s;
    if (s.status === 'off') return publicState(s);
    if (s.status === 'error') {
      s.status = 'off'; s.phase = 'off'; s.detail = 'GPU is off'; s.error = null;
      s.activeJobs = 0; await this.save(); return publicState(s);
    }
    s.stopRequested = true; s.stopReason = reason; s.stopAt = now();
    s.status = 'stopping'; s.phase = 'stopping'; s.detail = 'Draining requests, then releasing the GPU';
    await this.save();
    await this.state.storage.setAlarm(now() + 3000);
    return publicState(s);
  }

  async hold(minutes) {
    const s = this.s;
    const m = Math.max(0, Math.min(240, Number(minutes) || 0));
    s.holdUntil = m ? now() + m * 60000 : 0;
    await this.save();
    await this.state.storage.setAlarm(now() + 5000);
    return { holdUntil: s.holdUntil };
  }

  async register(body) {
    const s = this.s;
    if (!body.nonce || body.nonce !== s.nonce || (s.status !== 'starting' && s.status !== 'loading')) {
      return { stop: true, reason: 'no matching GPU session' };
    }
    const token = randomHex(32);
    const cfg = await config(this.env);
    s.runtimeHash = await sha256hex(token);
    s.status = 'loading'; s.phase = 'allocated';
    s.detail = 'GPU allocated; loading the model';
    s.allocatedAt = now(); s.lastHeartbeat = now(); s.lastActivity = now();
    s.gpus = body.gpus || []; s.error = null;
    await this.save();
    await this.state.storage.setAlarm(now() + 15000);
    return {
      stop: false, runtimeToken: token, dataset: cfg.dataset, modelFile: cfg.modelFile,
      modelBytes: cfg.modelBytes, modelSha256: cfg.modelSha256, servedModel: cfg.servedModel,
      ctx: cfg.ctx, parallel: cfg.parallel,
    };
  }

  applyRuntime(body) {
    const s = this.s;
    const map = { allocated: 'loading', loading: 'loading', ready: 'ready', busy: 'busy', stopping: 'stopping' };
    if (body.phase && map[body.phase]) s.phase = body.phase;
    if (!s.stopRequested && body.phase && map[body.phase]) s.status = map[body.phase];
    if (body.gpus) s.gpus = body.gpus;
    if (typeof body.activeJobs === 'number') s.activeJobs = body.activeJobs;
    if (typeof body.progress === 'number') s.progress = Math.max(0, Math.min(1, body.progress));
    if (body.detail) s.detail = String(body.detail).slice(0, 300);
    if (body.model) s.model = body.model;
    if (body.metrics) s.metrics = body.metrics;
    if (body.server) s.server = body.server;
    if (s.phase === 'ready' && !s.readyAt) {
      s.readyAt = now();
      s.lastActivity = Math.max(s.lastActivity || 0, s.readyAt);
    }
    s.lastHeartbeat = now();
  }

  async heartbeat(body) {
    this.applyRuntime(body);
    await this.save();
    return { stop: !!this.s.stopRequested, reason: this.s.stopReason };
  }

  async phase(body) {
    this.applyRuntime(body);
    await this.save();
    return { ok: true, stop: !!this.s.stopRequested };
  }

  async log(body) {
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const s = this.s;
    s.logTail = (s.logTail || []).concat(lines.map((l) => ({ ts: l.ts || now(), level: l.level || 'info', message: String(l.message || '').slice(0, 2000) }))).slice(-250);
    await this.storage.put('state', s);
    const bad = lines.filter((l) => l.level === 'error' || l.level === 'warn').slice(0, 5);
    for (const line of bad) {
      try {
        await this.env.DB.prepare('INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)')
          .bind(now(), 'gpu-log', String(line.message || '').slice(0, 500), null).run();
      } catch {}
    }
    return { ok: true };
  }

  async stopped(body) {
    const s = this.s;
    s.status = 'off'; s.phase = 'off'; s.detail = 'GPU is off';
    s.stopRequested = false; s.stopReason = body.reason || s.stopReason;
    s.activeJobs = 0; s.runtimeHash = null; s.stopAt = null; s.progress = 0;
    await this.save();
    await this.closeSession('stopped', body.reason);
    await this.state.storage.deleteAlarm();
    return { ok: true };
  }

  async runtimeError(body) {
    const s = this.s;
    s.status = 'error'; s.phase = 'error';
    s.error = String(body.error || 'runtime failure').slice(0, 600);
    s.detail = 'GPU runtime reported a failure';
    s.activeJobs = 0;
    await this.save();
    await this.log({ lines: [{ ts: now(), level: 'error', message: `${s.error} ${body.trace ? String(body.trace).slice(0, 1500) : ''}` }] });
    await this.closeSession('error', s.error);
    await this.state.storage.deleteAlarm();
    return { ok: true };
  }

  async poll(slot) {
    const s = this.s;
    if (s.stopRequested) return { stop: true, reason: s.stopReason };
    // A runtime that polls without a live session is orphaned: tell it to exit
    // so the Kaggle GPU is released instead of idling for the session timeout.
    if (!(s.status === 'loading' || s.status === 'ready' || s.status === 'busy')) return { stop: true, reason: 'no active GPU session' };
    const queue = await this.storage.list({ prefix: 'queue:' });
    const items = [...queue.entries()].sort((a, b) => Number(a[1]) - Number(b[1]));
    for (const [key] of items) {
      const id = key.slice('queue:'.length);
      const meta = await this.storage.get('job:' + id);
      await this.storage.delete(key);
      if (!meta || meta.status !== 'queued') continue;
      meta.status = 'running'; meta.leasedAt = now(); meta.slot = Number(slot) || 0;
      await this.storage.put('job:' + id, meta);
      this.jobs.set(id, { chunks: [], done: false, result: null, usage: null, error: null, cancelled: false, meta });
      return { stop: false, job: { id, body: meta.body, stream: !!meta.stream } };
    }
    return { stop: false, job: null };
  }

  async enqueue(body) {
    const s = this.s;
    const id = 'job_' + randomHex(8);
    const meta = {
      id, body: body.body || {}, stream: !!body.stream, keyId: body.keyId || null,
      status: 'queued', createdAt: now(), promptChars: body.promptChars || 0,
    };
    await this.storage.put('job:' + id, meta);
    await this.storage.put('queue:' + id, now());
    this.jobs.set(id, { chunks: [], done: false, result: null, usage: null, error: null, cancelled: false, meta });
    s.lastActivity = now();
    await this.save();
    await this.state.storage.setAlarm(now() + 5000);
    return { id, status: s.status };
  }

  async hydrate(id) {
    const meta = await this.storage.get('job:' + id);
    if (!meta) return null;
    const entry = {
      chunks: [], done: meta.status === 'done' || meta.status === 'error',
      result: null, usage: null, error: meta.error || null, cancelled: false, meta,
    };
    this.jobs.set(id, entry);
    return entry;
  }

  snapshot(entry, cursor) {
    return {
      chunks: entry.chunks.slice(cursor), cursor: entry.chunks.length,
      done: entry.done, error: entry.error, usage: entry.usage,
      result: entry.done && !entry.error ? entry.result : null,
    };
  }

  async waitJob(id, cursor, timeoutMs) {
    if (!id) return { missing: true };
    const entry = this.jobs.get(id) || (await this.hydrate(id));
    if (!entry) return { missing: true };
    if (entry.chunks.length > cursor || entry.done) return this.snapshot(entry, cursor);
    const limit = Math.max(1000, Math.min(25000, timeoutMs || 15000));
    return await new Promise((resolve) => {
      const set = this.waiters.get(id) || new Set();
      const finish = () => {
        clearTimeout(timer);
        set.delete(fn);
        resolve(this.snapshot(entry, cursor));
      };
      const timer = setTimeout(() => {
        set.delete(fn);
        resolve({ chunks: [], cursor, done: false, timeout: true });
      }, limit);
      const fn = finish;
      set.add(fn);
      this.waiters.set(id, set);
    });
  }

  wake(id) {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const fn of [...set]) fn();
    this.waiters.delete(id);
  }

  async chunk(body) {
    const entry = this.jobs.get(body.job) || (await this.hydrate(body.job));
    if (!entry) return { ok: false, cancel: true, error: 'unknown job' };
    if (Array.isArray(body.chunks) && body.chunks.length) entry.chunks.push(...body.chunks.map(String));
    entry.meta.status = 'running';
    const s = this.s;
    s.lastActivity = now();
    if (s.status === 'ready') s.status = 'busy';
    this.wake(body.job);
    return { ok: true, cancel: !!entry.cancelled };
  }

  async done(body) {
    const entry = this.jobs.get(body.job) || (await this.hydrate(body.job));
    if (!entry) return { ok: false };
    entry.done = true;
    entry.usage = body.usage || null;
    entry.result = body.result || null;
    entry.meta.status = body.cancelled ? 'cancelled' : 'done';
    await this.storage.put('job:' + body.job, entry.meta);
    const s = this.s;
    s.lastActivity = now();
    if (s.activeJobs > 0) s.activeJobs -= 1;
    if (s.status === 'busy' && s.activeJobs === 0) s.status = 'ready';
    this.wake(body.job);
    await this.save();
    await this.audit(entry);
    return { ok: true };
  }

  async audit(entry) {
    try {
      const u = entry.usage || {};
      await this.env.DB.prepare(
        `INSERT INTO requests (ts, job_id, key_id, status, prompt_tokens, completion_tokens, latency_ms, chars)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(now(), entry.meta.id, entry.meta.keyId, entry.meta.status,
        u.prompt_tokens || 0, u.completion_tokens || 0, now() - entry.meta.createdAt, entry.meta.promptChars || 0).run();
      if (entry.meta.keyId) {
        await this.env.DB.prepare('UPDATE api_keys SET requests = requests + 1, last_used_at = ? WHERE id = ?')
          .bind(now(), entry.meta.keyId).run();
      }
    } catch {}
  }

  async jobError(body) {
    const entry = this.jobs.get(body.job) || (await this.hydrate(body.job));
    if (!entry) return { ok: false };
    entry.done = true;
    entry.error = String(body.error || 'inference failed').slice(0, 600);
    entry.meta.status = 'error';
    entry.meta.error = entry.error;
    await this.storage.put('job:' + body.job, entry.meta);
    const s = this.s;
    s.lastActivity = now();
    if (s.activeJobs > 0) s.activeJobs -= 1;
    if (s.status === 'busy' && s.activeJobs === 0) s.status = 'ready';
    this.wake(body.job);
    await this.save();
    return { ok: true };
  }

  async cancel(jobId) {
    const entry = this.jobs.get(jobId) || (await this.hydrate(jobId));
    if (entry) {
      entry.cancelled = true;
      this.wake(jobId);
    }
    return { ok: true };
  }

  async failSession(message) {
    const s = this.s;
    s.status = 'error'; s.phase = 'error'; s.error = message; s.detail = 'GPU session failed'; s.activeJobs = 0;
    await this.save();
    await this.closeSession('error', message);
    try {
      await this.env.DB.prepare('INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)')
        .bind(now(), 'gpu', message, JSON.stringify({ sessionId: s.sessionId, kernelVersion: s.kernelVersion })).run();
    } catch {}
    await this.state.storage.deleteAlarm();
  }

  async finalizeOff(reason) {
    const s = this.s;
    s.status = 'off'; s.phase = 'off'; s.detail = 'GPU is off';
    s.activeJobs = 0; s.stopRequested = false; s.stopAt = null; s.runtimeHash = null; s.progress = 0;
    await this.save();
    await this.closeSession('stopped', reason);
    await this.state.storage.deleteAlarm();
  }

  async checkKernel() {
    const s = this.s;
    if (!s.kernelVersion) return;
    const cfg = await config(this.env);
    let info;
    try {
      info = await kaggle.sessionStatus(cfg);
    } catch {
      return;
    }
    const status = String(info.status || '').toUpperCase();
    if (status === 'RUNNING') s.sawRunning = true;
    if (status === 'ERROR' || status === 'CANCEL_ACKNOWLEDGED' || status === 'CANCEL_REQUESTED') {
      await this.failSession(info.failureMessage || `Kaggle kernel ${status.toLowerCase()}`);
    } else if (status === 'COMPLETE' && s.sawRunning) {
      await this.failSession('Kaggle kernel finished without registering its runtime');
    }
  }

  async alarm() {
    await this.load();
    const s = this.s;
    const t = now();
    if (s.status === 'off' || s.status === 'error') return;
    try {
      if (s.status === 'starting' || s.status === 'loading') {
        if (s.stopRequested) {
          s.status = 'stopping'; s.phase = 'stopping'; s.stopAt = s.stopAt || t;
          await this.save();
          await this.state.storage.setAlarm(t + 5000);
          return;
        }
        if (t - (s.startedAt || t) > STARTUP_TIMEOUT_MS) return this.failSession('GPU startup timed out after 20 minutes');
        if (s.allocatedAt && s.lastHeartbeat && t - s.lastHeartbeat > HEARTBEAT_STALE_MS) return this.failSession('Lost contact with the GPU runtime');
        if (s.status === 'starting') await this.checkKernel();
        await this.state.storage.setAlarm(t + 10000);
        return;
      }
      if (s.status === 'stopping') {
        if (t - (s.stopAt || t) > STOP_TIMEOUT_MS) return this.finalizeOff(s.stopReason || 'stop');
        await this.state.storage.setAlarm(t + 5000);
        return;
      }
      const cfg = await config(this.env);
      if (s.stopRequested) {
        s.status = 'stopping'; s.phase = 'stopping'; s.stopAt = t;
        await this.save();
        await this.state.storage.setAlarm(t + 5000);
        return;
      }
      const idleAt = (s.lastActivity || t) + cfg.idleMinutes * 60000;
      const deadline = Math.max(idleAt, s.holdUntil || 0);
      if ((s.activeJobs || 0) === 0 && t >= deadline) {
        await this.stop('idle timeout');
        await this.state.storage.setAlarm(t + 3000);
        return;
      }
      await this.state.storage.setAlarm(Math.min(deadline, t + 60000));
    } catch {
      await this.state.storage.setAlarm(now() + 15000);
    }
  }
}
