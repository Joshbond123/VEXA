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
import { normalizeDeviceAction, DEFAULT_RESOLUTION } from './device-actions.js';
import { handleAgent } from './agent.js';
import { handleFrontend } from './frontend.js';
import { handleSettings } from './settings.js';
import { EmulatorSession } from './durable-objects.js';
import { initDatabase, getDeviceState, upsertDeviceState, listAgentEvents, getAccessToken, migrateTokensFromKv } from './database.js';
import { kvGetJson, kvStats } from './kv.js';

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
    // Carry any tokens still held only in KV into D1. Idempotent and read-only
    // against KV, so it costs no write budget and is safe on every cold start.
    try {
      const { migrated } = await migrateTokensFromKv(env.DB, env.CONFIG_KV);
      if (migrated) console.log(`Migrated ${migrated} access token(s) from KV to D1`);
    } catch (err) {
      console.warn(`Token migration skipped: ${err.message}`);
    }
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
  if (!token) return null;
  // D1 is the source of truth; the KV read is a legacy fallback for a token
  // issued before the migration and not yet carried over.
  const data = await getAccessToken(env.DB, token).catch(() => null);
  if (data) return data;
  const legacy = await kvGetJson(env.CONFIG_KV, `access_token:${token}`);
  if (legacy) return legacy;
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
        version: '2.1.0',
        timestamp: new Date().toISOString(),
      }, { headers: corsHeaders() });
    }

    // GET /api/health/kv - KV write pressure and rate-limit visibility.
    // Reports the writes this isolate actually performed, how many were avoided
    // by dedupe/throttle, and whether any put() was rejected with 429. Read-only.
    if (path === '/api/health/kv' && method === 'GET') {
      return Response.json({ ok: true, ...kvStats() }, { headers: corsHeaders() });
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
          // A client on a weak link asks for a small frame with ?h=<px>. When a
          // downscaled variant was uploaded by the emulator it is served instead
          // of the multi-megabyte full PNG, which is what made the preview time
          // out on slow connections.
          const wantHeight = Number(url.searchParams.get('h') || 0);
          const small = state?.lastScreenshotSmallUrl || null;
          const full = state?.lastScreenshotUrl || null;
          const chosen = wantHeight && wantHeight <= 540 && small ? small : (full || small);
          if (chosen) {
            // Handle data URLs (base64-encoded images from emulator)
            if (chosen.startsWith('data:')) {
              const mime = (chosen.match(/^data:([^;]+);/) || [])[1] || 'image/png';
              const base64 = chosen.split(',')[1];
              const imgBuf = Buffer.from(base64, 'base64');
              return new Response(imgBuf, {
                headers: { ...corsHeaders(), 'Content-Type': mime, 'Cache-Control': 'no-store' },
              });
            }
            // Handle regular URLs
            try {
              const imgRes = await fetch(chosen);
              if (imgRes.ok) {
                const imgBuf = await imgRes.arrayBuffer();
                return new Response(imgBuf, {
                  headers: { ...corsHeaders(), 'Content-Type': imgRes.headers.get('content-type') || 'image/png', 'Cache-Control': 'no-store' },
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
        const action = normalizeDeviceAction(body, DEFAULT_RESOLUTION);

        const validActions = ['tap', 'swipe', 'scroll', 'type', 'key', 'back', 'home', 'launch', 'wait', 'screenshot'];
        if (!validActions.includes(action.action)) {
          return Response.json({ error: `Invalid action: ${action.action}` }, { status: 400, headers: corsHeaders() });
        }

        // Store the action in device state for the emulator to pick up
        await upsertDeviceState(env.DB, {
          lastAction: JSON.stringify(action),
          lastActionResult: 'pending',
        });

        return Response.json({ ok: true, action: action.action, queued: true }, { headers: corsHeaders() });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
      }
    }

    // === Emulator Routes ===
    if (path.startsWith('/api/emulator')) {
      return handleEmulator(request, env, ctx, token, corsHeaders);
    }

    // === Live agent activity stream (Server-Sent Events) ===
    // Real execution events written by the agent runtime are pushed to the
    // browser as they happen. The stream polls D1 for new events (Workers cannot
    // hold a DB subscription open) and flushes them in order; the client passes
    // the last seq it saw so a reconnect after a refresh resumes without gaps.
    if (path === '/api/frontend/events/stream' && method === 'GET') {
      const conversationId = url.searchParams.get('conversation') || null;
      const automationId = url.searchParams.get('automation') || null;
      let lastSeq = Number(url.searchParams.get('after') || 0);
      const encoder = new TextEncoder();
      let closed = false;
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event, data) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          send('open', { conversationId, automationId, after: lastSeq });
          // Poll D1 for new events. Interval is short enough to feel live and
          // long enough not to hammer the database.
          const poll = async () => {
            if (closed) return;
            try {
              const events = await listAgentEvents(env.DB, { conversationId, automationId, afterSeq: lastSeq, limit: 100 });
              for (const ev of events) {
                send('activity', ev);
                lastSeq = Math.max(lastSeq, ev.seq);
              }
              send('heartbeat', { at: Date.now(), seq: lastSeq });
            } catch (err) {
              send('error', { message: err.message });
            }
          };
          await poll();
          const timer = setInterval(async () => {
            if (closed) { clearInterval(timer); return; }
            await poll();
          }, 2000);
          // Bounded lifetime so an abandoned tab cannot hold the worker open.
          setTimeout(() => { closed = true; clearInterval(timer); try { controller.close(); } catch { /* already closed */ } }, 10 * 60 * 1000);
        },
        cancel() { closed = true; },
      });
      return new Response(stream, {
        headers: {
          ...corsHeaders(),
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
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
        version: '2.1.0',
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