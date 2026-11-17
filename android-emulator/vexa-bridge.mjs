/*
 * VEXA Android Remote Gateway (ADB bridge)
 *
 * Exposes the live Android emulator via HTTP for the VEXA AI agent and frontend.
 * Runs inside the android-emulator GitHub Action, started AFTER the emulator
 * boots so ADB can connect immediately.
 *
 * Endpoints:
 *   GET  /api/public/health          — device online/offline status
 *   GET  /api/public/screenshot      — real PNG screenshot from the device
 *   POST /api/agent/action           — tap, swipe, type, key, back, home, launch, shell, wait
 *
 * No secrets are required for device actions: the cloudflared tunnel URL is
 * public, and the frontend needs unauthenticated remote control. The
 * EMULATOR_GATEWAY_SECRET guards internal coordination (used by VIBELY-style
 * handover endpoints if added later).
 */

import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const ADB_BIN = process.env.ADB_PATH || '/usr/local/lib/android/sdk/platform-tools/adb';
const GATEWAY_SECRET = (process.env.EMULATOR_GATEWAY_SECRET || '').trim();

let detectedSerial = null;
let adbReady = false;

/* ------------------------------------------------------------------ ADB helpers */

async function adb(args, encoding = 'utf8', timeout = 15000) {
  const serialArg = detectedSerial ? ['-s', detectedSerial] : [];
  return execFileAsync(ADB_BIN, [...serialArg, ...args], {
    encoding,
    maxBuffer: 50 * 1024 * 1024,
    timeout,
  });
}

async function detectSerial() {
  try {
    const { stdout } = await execFileAsync(ADB_BIN, ['devices', '-l'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const lines = stdout.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === 'device') {
        detectedSerial = parts[0];
        return detectedSerial;
      }
    }
  } catch (err) {
    // No devices yet — will retry
  }
  return null;
}

async function ensureAdbReady() {
  if (adbReady && detectedSerial) return true;
  const serial = await detectSerial();
  if (!serial) return false;
  try {
    await adb(['get-state'], 'utf8', 5000);
    adbReady = true;
    console.log(`[VEXA Gateway] ADB device ready: ${detectedSerial}`);
    return true;
  } catch (err) {
    console.log(`[VEXA Gateway] ADB not ready yet: ${err.message}`);
    return false;
  }
}

/* ------------------------------------------------------------------ HTTP server */

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  /* ---------- public health ---------- */
  if (url.pathname === '/api/public/health') {
    const ready = await ensureAdbReady();
    let state = 'unknown';
    try {
      const { stdout } = await adb(['get-state'], 'utf8', 5000);
      state = stdout.trim();
    } catch { /* keep 'unknown' */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'vexa-adb-bridge',
      active_emulator_connected: ready && state === 'device',
      deviceModel: 'Pixel 7 (Android 14)',
      serial: detectedSerial || null,
      streaming: ready && state === 'device',
    }));
    return;
  }

  /* ---------- public screenshot ---------- */
  if (url.pathname === '/api/public/screenshot') {
    const ready = await ensureAdbReady();
    if (!ready) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Android device not connected' }));
      return;
    }
    try {
      const { stdout } = await adb(['exec-out', 'screencap', '-p'], 'buffer', 20000);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(stdout);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  /* ---------- agent action (public via tunnel) ---------- */
  if (url.pathname === '/api/agent/action' && req.method === 'POST') {
    const ready = await ensureAdbReady();
    if (!ready) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Android device not connected' }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body || '{}');
        const action = cmd.action;
        if (action === 'tap') {
          await adb(['shell', 'input', 'tap', String(cmd.x || 540), String(cmd.y || 1200)]);
        } else if (action === 'swipe') {
          await adb(['shell', 'input', 'swipe',
            String(cmd.x || 540), String(cmd.y || 1500),
            String(cmd.x2 || 540), String(cmd.y2 || 500),
            String(cmd.duration_ms || 300)]);
        } else if (action === 'scroll') {
          const x = cmd.x || 540;
          const y1 = cmd.y1 || 1700;
          const y2 = cmd.y2 || 700;
          await adb(['shell', 'input', 'swipe', String(x), String(y1), String(x), String(y2), '300']);
        } else if (action === 'type') {
          const escaped = String(cmd.text || '').replace(/ /g, '%s').replace(/['"\\]/g, '');
          await adb(['shell', 'input', 'text', escaped]);
        } else if (action === 'key') {
          await adb(['shell', 'input', 'keyevent', String(cmd.keycode || 66)]);
        } else if (action === 'back') {
          await adb(['shell', 'input', 'keyevent', '4']);
        } else if (action === 'home') {
          await adb(['shell', 'input', 'keyevent', '3']);
        } else if (action === 'recents') {
          await adb(['shell', 'input', 'keyevent', '187']);
        } else if (action === 'launch' && cmd.text) {
          await adb(['shell', 'monkey', '-p', String(cmd.text), '-c', 'android.intent.category.LAUNCHER', '1']);
        } else if (action === 'shell' && cmd.text) {
          await adb(['shell', String(cmd.text)]);
        } else if (action === 'wait') {
          await new Promise((r) => setTimeout(r, Math.min(10000, Number(cmd.ms || 2000))));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action, serial: detectedSerial }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`VEXA ADB Bridge listening on http://0.0.0.0:${PORT}`);
  const poll = setInterval(async () => {
    await ensureAdbReady();
    if (adbReady) clearInterval(poll);
  }, 2000);
});
