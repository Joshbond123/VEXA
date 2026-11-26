import {
  b64decode, b64encode, clearSessionCookie, error, getCookie, json, now, randomHex,
  readJson, sessionCookie, sha256hex, timingSafeEqual,
} from './util.js';

const PBKDF2_ITERATIONS = 100000;
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(stored, password) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt;
  let expected;
  try {
    salt = b64decode(parts[2]);
    expected = parts[3];
  } catch {
    return false;
  }
  const hash = await derive(password, salt, iterations);
  return timingSafeEqual(b64encode(hash), expected);
}

export async function createSession(env, operatorId, userAgent = '') {
  const token = randomHex(32);
  const tokenHash = await sha256hex(token);
  const t = now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, operator_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(tokenHash, operatorId, t, t + SESSION_TTL_MS, t, userAgent.slice(0, 250)).run();
  return token;
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
}

export async function destroyOtherSessions(env, operatorId, keepToken) {
  const keepHash = keepToken ? await sha256hex(keepToken) : '';
  await env.DB.prepare('DELETE FROM sessions WHERE operator_id = ? AND token_hash != ?').bind(operatorId, keepHash).run();
}

export async function getOperatorFromRequest(env, request) {
  const operatorKey = request.headers.get('x-operator-key');
  if (operatorKey && env.OPERATOR_KEY && timingSafeEqual(operatorKey, env.OPERATOR_KEY)) {
    return { id: 'op_admin', username: 'operator', role: 'admin', via: 'operator-key' };
  }
  const token = getCookie(request, 'vexa_session');
  if (!token) return null;
  const tokenHash = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.expires_at, o.id, o.username, o.role, o.must_change_password
       FROM sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = ?`,
  ).bind(tokenHash).first();
  if (!row || row.expires_at < now()) return null;
  env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').bind(now(), tokenHash).run().catch(() => {});
  return { id: row.id, username: row.username, role: row.role, mustChangePassword: !!row.must_change_password, via: 'session', token };
}

export async function requireOperator(env, request) {
  const op = await getOperatorFromRequest(env, request);
  if (!op) return { op: null, response: error('Authentication required', 401) };
  return { op, response: null };
}

async function logAuth(env, kind, message, detail) {
  try {
    await env.DB.prepare('INSERT INTO events (ts, kind, message, detail) VALUES (?, ?, ?, ?)')
      .bind(now(), kind, message, detail ? JSON.stringify(detail) : null).run();
  } catch {}
}

export async function handleAuth(request, env, path) {
  if (path === '/api/auth/session' && request.method === 'GET') {
    const setup = await env.DB.prepare('SELECT COUNT(*) AS n FROM operators').first();
    const op = await getOperatorFromRequest(env, request);
    return json({
      authenticated: !!op,
      operator: op ? { username: op.username, role: op.role, mustChangePassword: !!op.mustChangePassword } : null,
      setupRequired: (setup?.n || 0) === 0,
    });
  }

  if (path === '/api/auth/bootstrap' && request.method === 'POST') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM operators').first();
    if ((count?.n || 0) > 0) return error('Already initialised', 409);
    const body = await readJson(request);
    const username = String(body.username || 'admin').trim();
    const password = String(body.password || '');
    if (username.length < 3) return error('Username must be at least 3 characters');
    if (password.length < 10) return error('Password must be at least 10 characters');
    const t = now();
    await env.DB.prepare(
      'INSERT INTO operators (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    ).bind('op_' + randomHex(8), username, await hashPassword(password), 'admin', t, t).run();
    await logAuth(env, 'auth', `bootstrap admin ${username}`);
    return json({ ok: true });
  }

  if (path === '/api/auth/login' && request.method === 'POST') {
    const body = await readJson(request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const op = await env.DB.prepare('SELECT * FROM operators WHERE username = ?').bind(username).first();
    if (!op) {
      await verifyPassword(await hashPassword('invalid-password-placeholder'), password);
      await logAuth(env, 'auth', `failed login ${username}: unknown user`);
      return error('Incorrect username or password', 401);
    }
    if (op.locked_until && op.locked_until > now()) {
      return error('Too many failed attempts. Try again later.', 429);
    }
    if (!(await verifyPassword(op.password_hash, password))) {
      const failed = (op.failed_attempts || 0) + 1;
      await env.DB.prepare('UPDATE operators SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .bind(failed, failed >= MAX_FAILED_ATTEMPTS ? now() + LOCKOUT_MS : null, op.id).run();
      await logAuth(env, 'auth', `failed login ${username}: bad password`);
      return error('Incorrect username or password', 401);
    }
    const token = await createSession(env, op.id, request.headers.get('user-agent') || '');
    await env.DB.prepare('UPDATE operators SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .bind(now(), op.id).run();
    await logAuth(env, 'auth', `login ${op.username}`);
    return json({ ok: true, operator: { username: op.username, role: op.role, mustChangePassword: !!op.must_change_password } }, {
      headers: { 'set-cookie': sessionCookie(token) },
    });
  }

  if (path === '/api/auth/logout' && request.method === 'POST') {
    await destroySession(env, getCookie(request, 'vexa_session'));
    return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
  }

  if (path === '/api/auth/password' && request.method === 'POST') {
    const { op, response } = await requireOperator(env, request);
    if (!op) return response;
    const body = await readJson(request);
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    if (next.length < 10) return error('New password must be at least 10 characters');
    const row = await env.DB.prepare('SELECT password_hash FROM operators WHERE id = ?').bind(op.id).first();
    if (!row || !(await verifyPassword(row.password_hash, current))) return error('Current password is incorrect', 403);
    await env.DB.prepare('UPDATE operators SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .bind(await hashPassword(next), now(), op.id).run();
    await destroyOtherSessions(env, op.id, op.token);
    await logAuth(env, 'auth', `password changed ${op.username}`);
    return json({ ok: true });
  }

  return null;
}
