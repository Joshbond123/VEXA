import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);

async function adb(args, encoding = 'utf8') {
  return execFileAsync('adb', ['-s', 'emulator-5554', ...args], {
    encoding,
    maxBuffer: 25 * 1024 * 1024,
    timeout: 15000,
  });
}

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

  if (url.pathname === '/api/public/health') {
    try {
      const { stdout } = await adb(['get-state']);
      const connected = stdout.trim() === 'device';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'vexa-adb-bridge',
        active_emulator_connected: connected,
        deviceModel: 'Pixel 7 (Android 14)',
        streaming: connected,
      }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'vexa-adb-bridge', active_emulator_connected: false, error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/public/screenshot') {
    try {
      const { stdout } = await adb(['exec-out', 'screencap', '-p'], 'buffer');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(stdout);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/agent/action' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body || '{}');
        const action = cmd.action;
        if (action === 'tap') {
          await adb(['shell', 'input', 'tap', String(cmd.x || 540), String(cmd.y || 1200)]);
        } else if (action === 'swipe') {
          await adb(['shell', 'input', 'swipe', String(cmd.x || 540), String(cmd.y || 1500), String(cmd.x2 || 540), String(cmd.y2 || 500), '300']);
        } else if (action === 'type') {
          const escaped = String(cmd.text || '').replace(/ /g, '%s').replace(/['"\\]/g, '');
          await adb(['shell', 'input', 'text', escaped]);
        } else if (action === 'key') {
          await adb(['shell', 'input', 'keyevent', String(cmd.keycode || 3)]);
        } else if (action === 'back') {
          await adb(['shell', 'input', 'keyevent', '4']);
        } else if (action === 'home') {
          await adb(['shell', 'input', 'keyevent', '3']);
        } else if (action === 'launch' && cmd.text) {
          await adb(['shell', 'monkey', '-p', String(cmd.text), '-c', 'android.intent.category.LAUNCHER', '1']);
        } else if (action === 'shell' && cmd.text) {
          await adb(['shell', String(cmd.text)]);
        } else if (action === 'wait') {
          await new Promise((r) => setTimeout(r, Math.min(10000, Number(cmd.ms || 2000))));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action }));
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
});
