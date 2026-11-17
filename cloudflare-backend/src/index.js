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
import { initDatabase } from './database.js';

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
  // Check against stored tokens in KV or env
  const stored = await env.CONFIG_KV.get(`access_token:${token}`);
  if (stored) return JSON.parse(stored);
  
  // Fallback to env var
  if (token === env.EMULATOR_ACCESS_TOKEN) {
    return { type: 'emulator', token };
  }
  return null;
}

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

    // Test D1 insert
    if (path === '/api/test-d1' && method === 'POST') {
      try {
        await env.DB.prepare(`INSERT INTO settings (id, gateway_url, provider, model, api_key_encrypted, github_pat_encrypted, github_repo, cloudflare_account_id, cloudflare_api_token_encrypted, key_rotation, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          'test_default',
          'https://test.com',
          'nvidia',
          'nemotron',
          '',
          '',
          '',
          '',
          '',
          1,
          new Date().toISOString()
        ).run();
        return Response.json({ ok: true }, { headers: corsHeaders() });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
      }
    }

    // Root API info
    if (path === '/api' || path === '/') {
      return Response.json({
        service: 'VEXA AI Agent Backend',
        version: '2.0.0',
        endpoints: {
          health: '/api/health',
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
