/**
 * VEXA AI Agent — Cloudflare Workers Backend
 *
 * Main entry point for the VEXA platform backend.
 * Routes requests to appropriate handlers for:
 * - Frontend (GitHub Pages) API
 * - AI Agent task management
 * - Android Emulator registration & control
 * - Authentication & settings
 */

import { handleAuth } from './auth.js';
import { handleEmulator } from './emulator.js';
import { handleAgent } from './agent.js';
import { handleFrontend } from './frontend.js';
import { handleSettings } from './settings.js';
import { EmulatorSession } from './durable-objects.js';
import { initDatabase, getDeviceState, upsertDeviceState } from './database.js';

export { EmulatorSession };

/**
 * CORS headers for cross-origin requests from GitHub Pages
 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-VEXA-Token',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Initialize database tables on first request
 */
let dbInitialized = false;
async function ensureDB(env) {
  if (!dbInitialized) {
    await initDatabase(env.DB);
    dbInitialized = true;
  }
}

/**
 * Extract bearer token from Authorization header
 */
function getBearerToken(request) {
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.substring(7);
  }
  return null;
}

/**
 * Verify VEXA access token (from settings or env)
 */
async function verifyAccessToken(token, env) {
  const stored = await env.CONFIG_KV.get(`access_token:${token}`);
  if (stored) return JSON.parse(stored);
  if (token === env.EMULATOR_ACCESS_TOKEN) {
    return { type: 'emulator', token };
  }
  return null;
}

// Blank 1x1 transparent PNG for when no screenshot is available
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (path === '/api/health' || path === '/health') {
      return Response.json({
        ok: true,
        service: 'vexa-ai-agent',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
      }, { headers: corsHeaders() });
    }

    // Initialize database
    await ensureDB(env);

    // Auth middleware for protected routes
    const token = getBearerToken(request);

    // === Public endpoints for agent runner (mobilerun-compatible) ===
    if (path.startsWith('/api/public')) {
      // GET /api/public/health - public health check
      if (path === '/api/public/health' && method === 'GET') {
        return Response.json({
          ok: true,
          service: 'vexa-ai-agent-public',
          timestamp: new Date().toISOString(),
        }, { headers: corsHeaders() });
      }

      // GET /api/public/screenshot - get latest screenshot (returns image data)
      if (path === '/api/public/screenshot' && method === 'GET') {
        try {
          const state = await getDeviceState(env.DB);
          if (state?.lastScreenshotUrl) {
            const url = state.lastScreenshotUrl;
            // Handle data URLs (base64-encoded images from emulator)
            if (url.startsWith('data:')) {
              const base64 = url.split(',')[1];
              const imgBuf = Buffer.from(base64, 'base64');
              return new Response(imgBuf, {
                headers: { ...corsHeaders(), 'Content-Type': 'image/png' },
              });
            }
            // Handle regular URLs
            try {
              const imgRes = await fetch(url);
              if (imgRes.ok) {
                const imgBuf = await imgRes.arrayBuffer();
                return new Response(imgBuf, {
                  headers: { ...corsHeaders(), 'Content-Type': 'image/png' },
                });
              }
            } catch { /* fall through to blank */ }
          }
          // Return a blank 1x1 transparent PNG when no screenshot available
          return new Response(BLANK_PNG, {
            headers: { ...corsHeaders(), 'Content-Type': 'image/png' },
          });
        } catch (err) {
          return new Response(BLANK_PNG, {
            headers: { ...corsHeaders(), 'Content-Type': 'image/png' },
          });
        }
      }

      // GET /api/public/device-state - get UI hierarchy and device state for AI agent
      if (path === '/api/public/device-state' && method === 'GET') {
        try {
          const state = await getDeviceState(env.DB);
          if (!state) {
            return Response.json({ ok: true, screenshotUrl: null, uiHierarchy: null, lastActionResult: null }, { headers: corsHeaders() });
          }
          return Response.json({
            ok: true,
            screenshotUrl: state.lastScreenshotUrl || null,
            uiHierarchy: state.uiHierarchy || null,
            lastActionResult: state.lastActionResult || null,
            updatedAt: state.updatedAt || null,
          }, { headers: corsHeaders() });
        } catch (err) {
          return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
        }
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
    }

    // POST /api/agent/action - agent runner RPC endpoint (stores device action)
    if (path === '/api/agent/action' && method === 'POST') {
      try {
        const body = await request.json();
        const { action, x, y, x2, y2, text, keycode, app, ms } = body;

        const validActions = ['tap', 'swipe', 'scroll', 'type', 'key', 'back', 'home', 'launch', 'wait', 'screenshot'];
        if (!validActions.includes(action)) {
          return Response.json({ error: `Invalid action: ${action}` }, { status: 400, headers: corsHeaders() });
        }

        // Store the action in device state for the emulator to pick up
        await upsertDeviceState(env.DB, {
          lastAction: JSON.stringify({ action, x, y, x2, y2, text, keycode, app, ms }),
          lastActionResult: 'pending',
        });

        return Response.json({ ok: true, action, queued: true }, { headers: corsHeaders() });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
      }
    }

    // === Emulator Routes ===
    if (path.startsWith('/api/emulator')) {
      return handleEmulator(request, env, ctx, token, corsHeaders);
    }

    // === Agent Routes ===
    if (path.startsWith('/api/agent')) {
      return handleAgent(request, env, ctx, token, corsHeaders);
    }

    // === Frontend Routes (GitHub Pages) ===
    if (path.startsWith('/api/frontend')) {
      return handleFrontend(request, env, ctx, token, corsHeaders);
    }

    // === Settings Routes ===
    if (path.startsWith('/api/settings')) {
      return handleSettings(request, env, ctx, token, corsHeaders);
    }

    // === Auth Routes ===
    if (path.startsWith('/api/auth')) {
      return handleAuth(request, env, ctx, corsHeaders);
    }

    // === Durable Objects: Emulator Session ===
    if (path.startsWith('/api/session')) {
      const id = env.EmulatorSession.idFromName('main');
      const stub = env.EmulatorSession.get(id);
      return stub.fetch(request);
    }

    // Root API info
    if (path === '/api' || path === '/') {
      return Response.json({
        service: 'VEXA AI Agent Backend',
        version: '2.0.0',
        endpoints: {
          health: '/api/health',
          publicHealth: '/api/public/health',
          publicScreenshot: '/api/public/screenshot',
          agentAction: '/api/agent/action',
          auth: '/api/auth/*',
          emulator: '/api/emulator/*',
          agent: '/api/agent/*',
          frontend: '/api/frontend/*',
          settings: '/api/settings/*',
          session: '/api/session',
        },
        status: 'online',
      }, { headers: corsHeaders() });
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
  },
};