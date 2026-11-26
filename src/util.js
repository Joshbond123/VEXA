const enc = new TextEncoder();
const dec = new TextDecoder();

export const now = () => Date.now();

export function b64encode(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(str) {
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256hex(value) {
  const data = typeof value === 'string' ? enc.encode(value) : value;
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export function uuid() {
  return crypto.randomUUID();
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function corsHeaders(origin = '*') {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Operator-Key, X-VEXA-Key',
    'access-control-max-age': '86400',
  };
}

export function json(data, { status = 200, headers = {}, origin = '*' } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin), ...headers },
  });
}

export function error(message, status = 400, extra = {}) {
  return json({ error: { message, ...extra } }, { status });
}

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new Error('Request body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(token, maxAge = 7 * 24 * 3600) {
  return `vexa_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return 'vexa_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export function parseDurationSeconds(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400;
  }
  return Math.round(total);
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function truncate(str, n = 500) {
  const s = String(str ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export { enc, dec };
