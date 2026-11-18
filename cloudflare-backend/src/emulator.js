/**
 * VEXA Emulator Management Module
 * Handles Android emulator registration, heartbeat, screen streaming, and device control
 *
 * Architecture: Cloudflare Worker acts as the bridge between the AI agent runner
 * (GitHub Actions) and the Android emulator (separate GitHub Actions workflow).
 *   - Agent runner sends actions → stored in D1 device_state
 *   - Emulator polls for pending actions → executes via ADB → reports results
 *   - Emulator uploads screenshots → stored in D1 device_state
 *   - Agent runner reads screenshots → from D1 device_state
 */

import { upsertEmulatorSession, getEmulatorSession, upsertDeviceState, getDeviceState } from './database.js';

export async function handleEmulator(request, env, ctx, token, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Verify emulator access token (required for emulator-originating requests)
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

      // Initialize device state with no pending action and no screenshot
      await upsertDeviceState(env.DB, {
        screenChecksum: null,
        lastScreenshotUrl: null,
        lastAction: null,
        lastActionResult: null,
      });

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

  // POST /api/emulator/action - send device control action (from AI agent)
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
      const actionPayload = JSON.stringify({ action, x, y, x2, y2, text, keycode, app, ms });
      await upsertDeviceState(env.DB, {
        screenChecksum: null,
        lastScreenshotUrl: null,
        lastAction: actionPayload,
        lastActionResult: 'pending',
      });

      return Response.json({ ok: true, action, queued: true }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/emulator/pending-action - emulator polls for the next action to execute
  if (path === '/api/emulator/pending-action' && method === 'GET') {
    try {
      const state = await getDeviceState(env.DB);
      if (!state || !state.last_action || state.last_action_result !== 'pending') {
        return Response.json({ ok: true, action: null }, { headers: corsHeaders() });
      }

      const action = JSON.parse(state.last_action);
      return Response.json({ ok: true, action }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/emulator/action-result - emulator reports action execution result
  if (path === '/api/emulator/action-result' && method === 'POST') {
    try {
      const body = await request.json();
      const { action, success, error, screenshotBase64, checksum, uiHierarchy } = body;

      // Clear the pending action and record the result
      await upsertDeviceState(env.DB, {
        screenChecksum: checksum || null,
        lastScreenshotUrl: screenshotBase64 ? `data:image/png;base64,${screenshotBase64}` : null,
        uiHierarchy: uiHierarchy || null,
        lastAction: null,
        lastActionResult: JSON.stringify({ action, success, error, timestamp: new Date().toISOString() }),
      });

      return Response.json({ ok: true, message: 'Action result recorded' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/emulator/screenshot - get latest screenshot (JSON with URL)
  if (path === '/api/emulator/screenshot' && method === 'GET') {
    const state = await getDeviceState(env.DB);
    if (!state || !state.last_screenshot_url) {
      return Response.json({ error: 'No screenshot available' }, { status: 404, headers: corsHeaders() });
    }
    return Response.json({ ok: true, screenshotUrl: state.last_screenshot_url }, { headers: corsHeaders() });
  }

  // POST /api/emulator/screenshot - upload screenshot from emulator
  if (path === '/api/emulator/screenshot' && method === 'POST') {
    try {
      const body = await request.json();
      const { screenshotBase64, checksum, url: screenshotUrl, uiHierarchy } = body;

      await upsertDeviceState(env.DB, {
        screenChecksum: checksum || null,
        lastScreenshotUrl: screenshotUrl || (screenshotBase64 ? `data:image/png;base64,${screenshotBase64}` : null),
        uiHierarchy: uiHierarchy || null,
        updatedAt: new Date().toISOString(),
      });

      return Response.json({ ok: true, message: 'Screenshot saved' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/public/device-state - get UI hierarchy and device state for AI agent
  if (path === '/api/public/device-state' && method === 'GET') {
    const state = await getDeviceState(env.DB);
    if (!state) {
      return Response.json({ error: 'No device state available' }, { status: 404, headers: corsHeaders() });
    }
    return Response.json({
      ok: true,
      screenshotUrl: state.last_screenshot_url || null,
      uiHierarchy: state.ui_hierarchy || null,
      lastActionResult: state.last_action_result || null,
      updatedAt: state.updated_at || null,
    }, { headers: corsHeaders() });
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