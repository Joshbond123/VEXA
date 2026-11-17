/**
 * VEXA Emulator Management Module
 * Handles Android emulator registration, heartbeat, screen streaming, and device control
 */

import { upsertEmulatorSession, getEmulatorSession, upsertDeviceState, getDeviceState } from './database.js';

export async function handleEmulator(request, env, ctx, token, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Verify emulator access token
  if (token) {
    const verified = await verifyAccessToken(token, env);
    if (!verified && path !== '/api/emulator/register') {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
    }
  }

  // POST /api/emulator/register - register emulator with Cloudflare gateway
  if (path === '/api/emulator/register' && method === 'POST') {
    try {
      const body = await request.json();
      const { gatewayUrl, deviceModel, androidVersion, resolution, activeRunId, accessToken } = body;

      // Verify access token for registration
      if (accessToken !== env.EMULATOR_ACCESS_TOKEN) {
        return Response.json({ error: 'Invalid emulator access token' }, { status: 403, headers: corsHeaders() });
      }

      const session = {
        id: 'default',
        gatewayUrl,
        status: 'online',
        deviceModel,
        androidVersion,
        resolution,
        loggedInAccount: 'preserved-session',
        activeRunId,
        lastHeartbeat: new Date().toISOString(),
        registeredAt: new Date().toISOString(),
      };

      await upsertEmulatorSession(env.DB, session);

      // Also cache in KV for fast access
      await env.SESSION_KV.put('emulator:default', JSON.stringify(session), { expirationTtl: 3600 });

      return Response.json({
        ok: true,
        message: 'Emulator registered successfully',
        session,
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/emulator/heartbeat - update emulator heartbeat
  if (path === '/api/emulator/heartbeat' && method === 'POST') {
    try {
      const body = await request.json();
      const { status, deviceModel, androidVersion, resolution, activeRunId } = body;

      const existing = await getEmulatorSession(env.DB);
      const session = {
        id: 'default',
        gatewayUrl: existing?.gatewayUrl || '',
        status: status || 'online',
        deviceModel: deviceModel || existing?.deviceModel || 'Pixel 7',
        androidVersion: androidVersion || existing?.androidVersion || '14',
        resolution: resolution || existing?.resolution || '1080x2400',
        loggedInAccount: existing?.loggedInAccount || 'preserved-session',
        activeRunId: activeRunId || existing?.activeRunId,
        lastHeartbeat: new Date().toISOString(),
      };

      await upsertEmulatorSession(env.DB, session);
      await env.SESSION_KV.put('emulator:default', JSON.stringify(session), { expirationTtl: 3600 });

      return Response.json({
        ok: true,
        message: 'Heartbeat updated',
        session,
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/emulator/status - get emulator status
  if (path === '/api/emulator/status' && method === 'GET') {
    // Try KV first for fast access
    const cached = await env.SESSION_KV.get('emulator:default');
    if (cached) {
      return Response.json({ ok: true, session: JSON.parse(cached) }, { headers: corsHeaders() });
    }

    // Fall back to D1
    const session = await getEmulatorSession(env.DB);
    if (!session) {
      return Response.json({ ok: false, status: 'offline', message: 'No emulator registered' }, { headers: corsHeaders() });
    }

    // Check if heartbeat is stale (> 5 minutes)
    const lastBeat = new Date(session.lastHeartbeat).getTime();
    const now = Date.now();
    const isStale = (now - lastBeat) > 5 * 60 * 1000;

    return Response.json({
      ok: true,
      session: {
        ...session,
        status: isStale ? 'offline' : session.status,
      },
    }, { headers: corsHeaders() });
  }

  // POST /api/emulator/action - send device control action
  if (path === '/api/emulator/action' && method === 'POST') {
    try {
      const body = await request.json();
      const { action, x, y, x2, y2, text, keycode, app, ms } = body;

      // Validate action
      const validActions = ['tap', 'swipe', 'scroll', 'type', 'key', 'back', 'home', 'launch', 'wait', 'screenshot'];
      if (!validActions.includes(action)) {
        return Response.json({ error: `Invalid action: ${action}` }, { status: 400, headers: corsHeaders() });
      }

      // Store the action in device state for the emulator to pick up
      await upsertDeviceState(env.DB, {
        lastAction: JSON.stringify({ action, x, y, x2, y2, text, keycode, app, ms }),
        lastActionResult: 'pending',
      });

      // Notify Durable Object about the action
      const id = env.EmulatorSession.idFromName('main');
      const stub = env.EmulatorSession.get(id);
      
      try {
        const result = await stub.fetch('https://vexa.internal/api/session/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, x, y, x2, y2, text, keycode, app, ms }),
        });
        const resultData = await result.json();
        
        await upsertDeviceState(env.DB, {
          lastAction: JSON.stringify({ action, x, y, x2, y2, text, keycode, app, ms }),
          lastActionResult: JSON.stringify(resultData),
        });

        return Response.json({ ok: true, action, result: resultData }, { headers: corsHeaders() });
      } catch (doErr) {
        // Durable Object may not be available, still return ok
        return Response.json({ ok: true, action, queued: true }, { headers: corsHeaders() });
      }
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/emulator/screenshot - get latest screenshot
  if (path === '/api/emulator/screenshot' && method === 'GET') {
    const state = await getDeviceState(env.DB);
    if (!state || !state.last_screenshot_url) {
      return Response.json({ error: 'No screenshot available' }, { status: 404, headers: corsHeaders() });
    }
    return Response.json({ ok: true, screenshotUrl: state.last_screenshot_url }, { headers: corsHeaders() });
  }

  // POST /api/emulator/screenshot - upload screenshot
  if (path === '/api/emulator/screenshot' && method === 'POST') {
    try {
      const body = await request.json();
      const { screenshotBase64, checksum, url: screenshotUrl } = body;

      await upsertDeviceState(env.DB, {
        screenChecksum: checksum,
        lastScreenshotUrl: screenshotUrl,
        updatedAt: new Date().toISOString(),
      });

      // Store in R2 if available
      if (env.SCREENSHOTS_BUCKET && screenshotBase64) {
        try {
          const key = `screenshots/${Date.now()}.png`;
          await env.SCREENSHOTS_BUCKET.put(key, screenshotBase64, {
            httpMetadata: { contentType: 'image/png' },
          });
        } catch (r2Err) {
          // R2 not configured, continue without it
        }
      }

      return Response.json({ ok: true, message: 'Screenshot saved' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // DELETE /api/emulator/session - unregister emulator
  if (path === '/api/emulator/session' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM emulator_sessions WHERE id = ?').bind('default').run();
    await env.SESSION_KV.delete('emulator:default');
    return Response.json({ ok: true, message: 'Emulator unregistered' }, { headers: corsHeaders() });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}

async function verifyAccessToken(token, env) {
  if (!token) return null;
  const stored = await env.CONFIG_KV.get(`access_token:${token}`);
  if (stored) return JSON.parse(stored);
  if (token === env.EMULATOR_ACCESS_TOKEN) {
    return { type: 'emulator', token };
  }
  return null;
}
