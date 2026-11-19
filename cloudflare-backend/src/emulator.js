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

import { upsertEmulatorSession, getEmulatorSession, upsertDeviceState, getDeviceState, claimDeviceAction, touchEmulatorHeartbeat, getAccessToken } from './database.js';
import { kvPutJson, kvGetJson } from './kv.js';
import { normalizeDeviceAction, resolutionFromSession, DEFAULT_RESOLUTION } from './device-actions.js';

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

      // KV is a read-through cache only. Registration is rare, so it may write,
      // but it goes through the shared wrapper so a 429 can never fail a
      // registration (D1 already holds the session).
      await kvPutJson(env.SESSION_KV, 'emulator:default', session, {
        expirationTtl: 3600,
        minIntervalMs: 0,
        force: true,
      });

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

      // A heartbeat is a liveness signal, not a state change. D1 owns the
      // session, so the row is only rewritten when the reported identity
      // actually changed, or when the stored beat is older than the heartbeat
      // write interval. The previous code rewrote the whole row — and the whole
      // KV mirror — on every 30s beat, which is what exhausted the KV daily cap.
      const existing = await getEmulatorSession(env.DB);
      const nextStatus = status || 'online';
      const identityChanged = !existing
        || existing.status !== nextStatus
        || (deviceModel && existing.deviceModel !== deviceModel)
        || (resolution && existing.resolution !== resolution)
        || (androidVersion && existing.androidVersion !== androidVersion)
        || (activeRunId && existing.activeRunId !== activeRunId);

      const session = {
        id: 'default',
        gatewayUrl: existing?.gatewayUrl || '',
        status: nextStatus,
        deviceModel: deviceModel || existing?.deviceModel || 'Pixel 7',
        androidVersion: androidVersion || existing?.androidVersion || '14',
        resolution: resolution || existing?.resolution || '1080x2400',
        loggedInAccount: existing?.loggedInAccount || 'preserved-session',
        activeRunId: activeRunId || existing?.activeRunId,
        lastHeartbeat: new Date().toISOString(),
      };

      if (existing && !identityChanged) {
        await touchEmulatorHeartbeat(env.DB);
      } else {
        await upsertEmulatorSession(env.DB, session);
        // Only a genuine identity change refreshes the cache; the 30s liveness
        // beat never touches KV. A stale-but-valid cache entry is corrected by
        // the D1 fallback in the read paths.
        await kvPutJson(env.SESSION_KV, 'emulator:default', session, {
          expirationTtl: 3600,
          minIntervalMs: 60 * 60 * 1000,
        });
      }

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
      const action = normalizeDeviceAction(body, await resolveDeviceResolution(env));

      // Validate action
      const validActions = ['tap', 'swipe', 'scroll', 'type', 'key', 'back', 'home', 'recents', 'launch', 'wait', 'screenshot', 'shell'];
      if (!validActions.includes(action.action)) {
        return Response.json({ error: `Invalid action: ${action.action}` }, { status: 400, headers: corsHeaders() });
      }

      // Duplicate suppression: a second request carrying the same client id as
      // an action that is still pending must not queue a device command twice.
      // The claim is a conditional UPDATE so it holds even when two requests
      // arrive concurrently — a read-then-write check let both through and the
      // phone acted twice on a double tap.
      const clientId = body.clientId || null;
      const claimed = await claimDeviceAction(env.DB, { action, clientId });
      if (!claimed) {
        return Response.json({ ok: true, action: action.action, queued: true, duplicate: true }, { headers: corsHeaders() });
      }

      return Response.json({ ok: true, action: action.action, queued: true, clientId }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/emulator/pending-action - emulator polls for the next action to execute
  if (path === '/api/emulator/pending-action' && method === 'GET') {
    try {
      const state = await getDeviceState(env.DB);
      if (!state || !state.lastAction || state.lastActionResult !== 'pending') {
        return Response.json({ ok: true, action: null }, { headers: corsHeaders() });
      }

      const action = JSON.parse(state.lastAction);
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

      // Record the result. Screenshot/UI-tree fields are only included when the
      // emulator actually captured them: upsertDeviceState merges, so omitting a
      // field preserves the previous frame instead of blanking the preview.
      const patch = {
        lastAction: null,
        lastActionResult: JSON.stringify({ action, success, error, timestamp: new Date().toISOString() }),
        lastActionStatus: 'done',
      };
      if (screenshotBase64) patch.lastScreenshotUrl = `data:image/png;base64,${screenshotBase64}`;
      if (checksum) patch.screenChecksum = checksum;
      if (uiHierarchy) patch.uiHierarchy = uiHierarchy;
      await upsertDeviceState(env.DB, patch);

      return Response.json({ ok: true, message: 'Action result recorded' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/emulator/screenshot - get latest screenshot (JSON with URL)
  if (path === '/api/emulator/screenshot' && method === 'GET') {
    const state = await getDeviceState(env.DB);
    if (!state || !state.lastScreenshotUrl) {
      return Response.json({ error: 'No screenshot available' }, { status: 404, headers: corsHeaders() });
    }
    return Response.json({ ok: true, screenshotUrl: state.lastScreenshotUrl }, { headers: corsHeaders() });
  }

  // POST /api/emulator/screenshot - upload screenshot from emulator
  if (path === '/api/emulator/screenshot' && method === 'POST') {
    try {
      const body = await request.json();
      const { screenshotBase64, checksum, url: screenshotUrl, uiHierarchy, smallScreenshotBase64 } = body;

      // Only patch the fields this upload actually carries. upsertDeviceState
      // merges, so sending uiHierarchy: null on a frame where the uiautomator
      // dump failed would erase the last known UI tree and silently blind the
      // agent. Omit absent fields instead.
      const patch = { updatedAt: new Date().toISOString() };
      const fullUrl = screenshotUrl || (screenshotBase64 ? `data:image/png;base64,${screenshotBase64}` : null);
      if (fullUrl) patch.lastScreenshotUrl = fullUrl;
      if (smallScreenshotBase64) patch.lastScreenshotSmallUrl = `data:image/jpeg;base64,${smallScreenshotBase64}`;
      if (checksum) patch.screenChecksum = checksum;
      if (uiHierarchy) patch.uiHierarchy = uiHierarchy;

      await upsertDeviceState(env.DB, patch);

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
      screenshotUrl: state.lastScreenshotUrl || null,
      uiHierarchy: state.uiHierarchy || null,
      lastActionResult: state.lastActionResult || null,
      updatedAt: state.updatedAt || null,
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

/* Resolve the device's real pixel resolution so normalised coordinates can be
 * converted to pixels. Falls back to a default when unknown. */
async function resolveDeviceResolution(env) {
  try {
    const raw = await env.SESSION_KV?.get('emulator:default');
    const session = raw ? JSON.parse(raw) : await getEmulatorSession(env.DB);
    return resolutionFromSession(session);
  } catch {
    return DEFAULT_RESOLUTION;
  }
}

async function verifyAccessToken(token, env) {
  if (!token) return null;
  const data = await getAccessToken(env.DB, token).catch(() => null);
  if (data) return data;
  if (token === env.EMULATOR_ACCESS_TOKEN) {
    return { type: 'emulator', token };
  }
  return null;
}
