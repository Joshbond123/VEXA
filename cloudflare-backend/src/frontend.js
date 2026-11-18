/**
 * VEXA Frontend API Module
 * Serves data to the GitHub Pages frontend
 */

import {
  getAutomations, getAutomation, upsertAutomation,
  getChats, saveChatMessage,
  getEmulatorSession,
} from './database.js';

export async function handleFrontend(request, env, ctx, token, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Verify token for write operations
  if (method !== 'GET' && token) {
    const stored = await env.CONFIG_KV.get(`access_token:${token}`);
    if (!stored) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
    }
  }

  // GET /api/frontend/automations - list automations
  if (path === '/api/frontend/automations' && method === 'GET') {
    try {
      const automations = await getAutomations(env.DB);
      return Response.json({ ok: true, automations }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/frontend/automations - create automation
  if (path === '/api/frontend/automations' && method === 'POST') {
    try {
      const body = await request.json();
      const now = new Date().toISOString();
      const automation = {
        id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: body.name || 'New Automation',
        instructions: body.instructions || '',
        scheduleType: body.scheduleType || 'once',
        intervalMinutes: body.intervalMinutes || 60,
        enabled: body.enabled !== false,
        paused: body.paused || false,
        status: body.status || 'queued',
        nextRunAt: body.nextRunAt || now,
        lastRunAt: '',
        lastRunStatus: '',
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await upsertAutomation(env.DB, automation);
      return Response.json({ ok: true, automation }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // PUT /api/frontend/automations/:id - update automation
  if (path.match(/^\/api\/frontend\/automations\/[^/]+$/) && method === 'PUT') {
    try {
      const id = path.split('/').pop();
      const body = await request.json();
      const automation = { ...body, id, updatedAt: new Date().toISOString() };
      await upsertAutomation(env.DB, automation);
      return Response.json({ ok: true, automation }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // DELETE /api/frontend/automations/:id - delete automation
  if (path.match(/^\/api\/frontend\/automations\/[^/]+$/) && method === 'DELETE') {
    try {
      const id = path.split('/').pop();
      await env.DB.prepare('DELETE FROM automations WHERE id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM chats WHERE automation_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM executions WHERE automation_id = ?').bind(id).run();
      return Response.json({ ok: true, message: 'Automation deleted' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/frontend/emulator-status - get emulator status for frontend
  if (path === '/api/frontend/emulator-status' && method === 'GET') {
    try {
      // Try KV first
      const cached = await env.SESSION_KV.get('emulator:default');
      if (cached) {
        const session = JSON.parse(cached);
        const lastBeat = new Date(session.lastHeartbeat).getTime();
        const now = Date.now();
        const isStale = (now - lastBeat) > 5 * 60 * 1000;
        return Response.json({
          ok: true,
          online: !isStale && session.status === 'online',
          gatewayUrl: session.gatewayUrl,
          deviceModel: session.deviceModel,
          androidVersion: session.androidVersion,
          resolution: session.resolution,
          lastHeartbeat: session.lastHeartbeat,
        }, { headers: corsHeaders() });
      }

      const session = await getEmulatorSession(env.DB);
      if (!session) {
        return Response.json({ ok: false, online: false, message: 'No emulator registered' }, { headers: corsHeaders() });
      }
      const lastBeat = new Date(session.lastHeartbeat).getTime();
      const now = Date.now();
      const isStale = (now - lastBeat) > 5 * 60 * 1000;
      return Response.json({
        ok: true,
        online: !isStale && session.status === 'online',
        gatewayUrl: session.gatewayUrl,
        deviceModel: session.deviceModel,
        androidVersion: session.androidVersion,
        resolution: session.resolution,
        lastHeartbeat: session.lastHeartbeat,
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/frontend/settings - get settings
  if (path === '/api/frontend/settings' && method === 'GET') {
    try {
      const kvConfig = await env.CONFIG_KV.get('settings_config');
      if (!kvConfig) {
        return Response.json({ ok: true, settings: {} }, { headers: corsHeaders() });
      }
      const config = JSON.parse(kvConfig);
      const safeSettings = {
        gatewayUrl: config.gatewayUrl || '',
        provider: config.provider || 'nvidia',
        model: config.model || 'nemotron-3.5-super-vl-120b-a12b',
        keyRotation: config.keyRotation !== false,
        hasApiKey: !!config.apiKeyEncrypted,
        hasGitHubPat: !!config.githubPatEncrypted,
        cloudflareAccountId: config.cloudflareAccountId || '',
      };
      return Response.json({ ok: true, settings: safeSettings }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/frontend/settings - save settings
  if (path === '/api/frontend/settings' && method === 'POST') {
    try {
      const body = await request.json();
      const settings = {
        gatewayUrl: body.gatewayUrl || '',
        provider: body.provider || 'nvidia',
        model: body.model || 'nemotron-3.5-super-vl-120b-a12b',
        apiKeyEncrypted: body.apiKey || '',
        githubPatEncrypted: body.githubPat || '',
        githubRepo: body.githubRepo || '',
        cloudflareAccountId: body.cloudflareAccountId || '',
        cloudflareApiTokenEncrypted: body.cloudflareApiToken || '',
        keyRotation: body.keyRotation !== false,
      };
      await env.CONFIG_KV.put('settings_config', JSON.stringify(settings), { expirationTtl: 86400 * 30 });

      return Response.json({ ok: true, message: 'Settings saved' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/frontend/chats/:automationId - get chat history
  if (path.match(/^\/api\/frontend\/chats\/[^/]+$/) && method === 'GET') {
    const automationId = path.split('/').pop();
    const chats = await getChats(env.DB, automationId);
    return Response.json({ ok: true, chats }, { headers: corsHeaders() });
  }

  // POST /api/frontend/chats/:automationId - send chat message
  if (path.match(/^\/api\/frontend\/chats\/[^/]+$/) && method === 'POST') {
    try {
      const automationId = path.split('/').pop();
      const body = await request.json();
      const { role, content } = body;

      await saveChatMessage(env.DB, {
        id: `msg_${Date.now()}`,
        automationId,
        role: role || 'user',
        content,
        timestamp: new Date().toISOString(),
      });

      return Response.json({ ok: true, message: 'Message saved' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}