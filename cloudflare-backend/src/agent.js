/**
 * VEXA AI Agent Module
 * Handles AI agent task management, execution, and provider integration
 */

import {
  getAutomations, getAutomation, upsertAutomation,
  saveExecution, saveChatMessage, getChats,
  getSettings, upsertSettings, appendAgentEvent, getAccessToken,
} from './database.js';

export async function handleAgent(request, env, ctx, token, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Verify token
  if (token) {
    const data = await getAccessToken(env.DB, token);
    if (!data) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
    }
  }

  // POST /api/agent/run - dispatch agent task
  if (path === '/api/agent/run' && method === 'POST') {
    try {
      const body = await request.json();
      const { automationId, instructions } = body;

      if (!automationId && !instructions) {
        return Response.json({ error: 'Automation ID or instructions required' }, { status: 400, headers: corsHeaders() });
      }

      // Get or create automation
      let automation;
      if (automationId) {
        automation = await getAutomation(env.DB, automationId);
      }

      if (!automation) {
        const now = new Date().toISOString();
        automation = {
          id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: 'Agent Task',
          instructions: instructions || 'Execute task on Android device',
          scheduleType: 'once',
          intervalMinutes: 60,
          enabled: true,
          paused: false,
          status: 'queued',
          nextRunAt: now,
          lastRunAt: '',
          lastRunStatus: '',
          runCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        await upsertAutomation(env.DB, automation);
      }

      // Mark as running
      automation.status = 'running';
      automation.lastRunAt = new Date().toISOString();
      automation.runCount = (automation.runCount || 0) + 1;
      await upsertAutomation(env.DB, automation);

      // Save chat message
      await saveChatMessage(env.DB, {
        id: `msg_${Date.now()}`,
        automationId: automation.id,
        role: 'system',
        content: `Agent task dispatched: ${automation.instructions}`,
        timestamp: new Date().toISOString(),
      });

      // Dispatch to GitHub Actions agent-runner workflow
      const dispatchResult = await dispatchAgentRunner(env, automation.id);

      return Response.json({
        ok: true,
        automationId: automation.id,
        status: 'running',
        dispatched: dispatchResult.ok,
        message: 'Agent task dispatched to GitHub Actions',
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/agent/automations - list all automations
  if (path === '/api/agent/automations' && method === 'GET') {
    try {
      const automations = await getAutomations(env.DB);
      return Response.json({ ok: true, automations }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/agent/automations/:id - get automation
  if (path.match(/^\/api\/agent\/automations\/[^/]+$/) && method === 'GET') {
    const id = path.split('/').pop();
    const automation = await getAutomation(env.DB, id);
    if (!automation) {
      return Response.json({ error: 'Automation not found' }, { status: 404, headers: corsHeaders() });
    }
    return Response.json({ ok: true, automation }, { headers: corsHeaders() });
  }

  // PUT /api/agent/automations/:id - update automation
  if (path.match(/^\/api\/agent\/automations\/[^/]+$/) && method === 'PUT') {
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

  // GET /api/agent/chats/:automationId - get chat history
  if (path.match(/^\/api\/agent\/chats\/[^/]+$/) && method === 'GET') {
    const automationId = path.split('/').pop();
    const chats = await getChats(env.DB, automationId);
    return Response.json({ ok: true, chats }, { headers: corsHeaders() });
  }

  // POST /api/agent/events - append real agent activity events.
  // The agent runner calls this as it plans, calls tools, observes results and
  // verifies. These are the only source of the live activity feed; the frontend
  // never fabricates an event.
  if (path === '/api/agent/events' && method === 'POST') {
    try {
      const body = await request.json();
      const events = Array.isArray(body.events) ? body.events : [body];
      const seqs = [];
      for (const ev of events) {
        seqs.push(await appendAgentEvent(env.DB, ev));
      }
      return Response.json({ ok: true, appended: seqs.length, seqs }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/agent/execution - save execution report
  if (path === '/api/agent/execution' && method === 'POST') {
    try {
      const body = await request.json();
      await saveExecution(env.DB, body);

      // Save chat summary
      await saveChatMessage(env.DB, {
        id: `msg_${Date.now()}`,
        automationId: body.automationId,
        role: 'agent',
        content: `Execution report: ${body.status} - ${body.observedResults || 'N/A'}`,
        timestamp: body.finishedAt || new Date().toISOString(),
        executionId: body.id,
      });

      return Response.json({ ok: true, message: 'Execution saved' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/agent/executions/:automationId - get execution history
  if (path.match(/^\/api\/agent\/executions\/[^/]+$/) && method === 'GET') {
    const automationId = path.split('/').pop();
    const { results } = await env.DB.prepare(
      'SELECT * FROM executions WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(automationId).all();
    return Response.json({ ok: true, executions: results }, { headers: corsHeaders() });
  }

  // GET /api/agent/settings - get agent settings
  if (path === '/api/agent/settings' && method === 'GET') {
    const settings = await getSettings(env.DB);
    if (!settings) {
      return Response.json({ ok: true, settings: { provider: 'nvidia', keyRotation: true } }, { headers: corsHeaders() });
    }
    // Don't return encrypted keys
    const safeSettings = {
      gatewayUrl: settings.gateway_url,
      provider: settings.provider,
      model: settings.model,
      keyRotation: settings.key_rotation === 1,
      hasApiKey: !!settings.api_key_encrypted,
      hasGitHubPat: !!settings.github_pat_encrypted,
      hasCloudflareToken: !!settings.cloudflare_api_token_encrypted,
    };
    return Response.json({ ok: true, settings: safeSettings }, { headers: corsHeaders() });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}

/**
 * Dispatch the GitHub Actions agent-runner workflow
 */
async function dispatchAgentRunner(env, automationId) {
  const githubPat = await getGitHubPat(env);
  if (!githubPat) {
    return { ok: false, error: 'GitHub PAT not configured' };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/Joshbond123/VEXA/actions/workflows/agent-runner.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'VEXA-Platform/1.0',
        },
        body: JSON.stringify({
          ref: 'vexa',
          inputs: { automation_id: automationId },
        }),
      }
    );

    if (res.ok) {
      return { ok: true };
    }
    return { ok: false, error: `GitHub API: ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get GitHub PAT from settings or KV
 */
async function getGitHubPat(env) {
  const settings = await getSettings(env.DB);
  if (settings?.github_pat_encrypted) {
    const stored = await env.CONFIG_KV.get('github_pat');
    if (stored) return stored;
    return env.GITHUB_PAT;
  }
  return env.GITHUB_PAT;
}