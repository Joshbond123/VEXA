/**
 * VEXA Frontend API Module
 * Serves data to the GitHub Pages frontend
 */

import {
  getAutomations, getAutomation, upsertAutomation,
  getChats, saveChatMessage,
  getEmulatorSession, getDeviceState, upsertDeviceState,
} from './database.js';

const REPO = 'Joshbond123/VEXA';
const DEFAULT_WORKER_URL = 'https://vexa-ai-agent.replyraven001.workers.dev';

/** Read the GitHub PAT from settings or the Worker secret. */
async function resolveGitHubPat(env) {
  try {
    const cfg = await env.CONFIG_KV.get('settings_config');
    if (cfg) {
      const parsed = JSON.parse(cfg);
      if (parsed.githubPatEncrypted) return parsed.githubPatEncrypted;
    }
  } catch { /* fall through to the Worker secret */ }
  return env.GITHUB_PAT || '';
}

/** Read the AI provider keys (one per line) and primary provider from settings. */
async function resolveProviderConfig(env) {
  let cfg = {};
  try {
    const raw = await env.CONFIG_KV.get('settings_config');
    if (raw) cfg = JSON.parse(raw);
  } catch { /* ignore */ }
  const keys = String(cfg.apiKeyEncrypted || '').split(/[\n,]/).map((k) => k.trim()).filter(Boolean);
  return { provider: cfg.provider || 'nvidia', model: cfg.model || '', keys };
}

const PROVIDER_ENDPOINTS = {
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' },
  grok: { url: 'https://api.x.ai/v1/chat/completions', model: 'grok-2-vision-1212' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
};

/**
 * Pick the model id for a provider. A stored override is only honoured when it
 * is fully qualified (contains a slash); bare names such as
 * `nemotron-3.5-super-vl-120b-a12b` would be rejected by NVIDIA's API, which
 * requires the `nvidia/` namespace.
 */
function modelFor(pid, ep, storedModel, isPrimary) {
  if (isPrimary && storedModel && storedModel.includes('/')) return storedModel;
  return ep.model;
}

/**
 * Ask the configured AI provider. Tries every stored key and falls over to the
 * next provider on failure, mirroring the agent runner's rotation behaviour.
 * Reasoning models (nemotron) may return their text in `reasoning_content`
 * with an empty `content` when the token budget is consumed by thinking, so
 * both fields are accepted.
 */
async function askAi(env, { messages, maxTokens = 1600 }) {
  const { provider, model, keys } = await resolveProviderConfig(env);
  if (!keys.length) return { ok: false, error: 'No API key configured. Add one in Settings.' };

  const order = [provider, ...Object.keys(PROVIDER_ENDPOINTS).filter((p) => p !== provider)];
  let lastError = '';
  for (const pid of order) {
    const ep = PROVIDER_ENDPOINTS[pid];
    if (!ep) continue;
    for (const key of keys) {
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelFor(pid, ep, model, pid === provider),
            messages,
            temperature: 0.3,
            max_tokens: maxTokens,
          }),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 200);
          lastError = `${pid} HTTP ${res.status}${detail ? ` ${detail}` : ''}`;
          if (res.status === 429 || res.status >= 500) continue;
          break;
        }
        const json = await res.json();
        const msg = json.choices?.[0]?.message || {};
        const content = (msg.content || msg.reasoning_content || '').trim();
        if (content) return { ok: true, content, provider: pid };
        lastError = `${pid}: empty response`;
      } catch (err) {
        lastError = `${pid}: ${err.message}`;
      }
    }
  }
  return { ok: false, error: `All providers failed. ${lastError}` };
}

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
      let session = null;
      const cached = await env.SESSION_KV.get('emulator:default');
      if (cached) {
        try { session = JSON.parse(cached); } catch { session = null; }
      }
      if (!session) session = await getEmulatorSession(env.DB);

      if (!session) {
        return Response.json({
          ok: true, online: false, registered: false,
          message: 'No emulator registered',
        }, { headers: corsHeaders() });
      }

      const now = Date.now();
      const lastBeat = new Date(session.lastHeartbeat || 0).getTime();
      const heartbeatAgeMs = now - lastBeat;
      const isStale = heartbeatAgeMs > 5 * 60 * 1000;

      // A live preview needs a recent frame, not just a heartbeat.
      const state = await getDeviceState(env.DB);
      const frameAt = state?.updatedAt ? new Date(state.updatedAt).getTime() : 0;
      const frameAgeMs = frameAt ? now - frameAt : null;
      const hasFrame = !!state?.lastScreenshotUrl;
      const frameFresh = hasFrame && frameAgeMs !== null && frameAgeMs < 60 * 1000;

      return Response.json({
        ok: true,
        online: !isStale && session.status === 'online',
        registered: true,
        hasFrame,
        frameFresh,
        frameAgeMs,
        heartbeatAgeMs,
        gatewayUrl: session.gatewayUrl,
        deviceModel: session.deviceModel,
        androidVersion: session.androidVersion,
        resolution: session.resolution,
        lastHeartbeat: session.lastHeartbeat,
        screenshotUrl: hasFrame ? `${DEFAULT_WORKER_URL}/api/public/screenshot` : null,
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/frontend/emulator/start - dispatch the Android emulator workflow
  if (path === '/api/frontend/emulator/start' && method === 'POST') {
    try {
      const pat = await resolveGitHubPat(env);
      if (!pat) {
        return Response.json({ ok: false, error: 'GitHub PAT not configured. Add it in Settings.' }, { status: 400, headers: corsHeaders() });
      }
      let body = {};
      try { body = await request.json(); } catch { /* optional body */ }
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/android-emulator.yml/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'VEXA-Platform/1.0',
        },
        body: JSON.stringify({
          ref: 'vexa',
          inputs: {
            rotation_minutes: String(body.rotationMinutes || 240),
            restore_state: body.restoreState ? 'true' : 'false',
          },
        }),
      });
      if (res.status === 204) {
        return Response.json({ ok: true, message: 'Emulator workflow dispatched. Boot takes 5-10 minutes.' }, { headers: corsHeaders() });
      }
      const txt = await res.text().catch(() => '');
      return Response.json({ ok: false, error: `GitHub API ${res.status}: ${txt.slice(0, 300)}` }, { status: 502, headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/frontend/emulator/stop - stop the running emulator
  if (path === '/api/frontend/emulator/stop' && method === 'POST') {
    try {
      const pat = await resolveGitHubPat(env);
      if (!pat) {
        return Response.json({ ok: false, error: 'GitHub PAT not configured. Add it in Settings.' }, { status: 400, headers: corsHeaders() });
      }
      const ghHeaders = {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'VEXA-Platform/1.0',
      };
      // Cancel in-flight runs of the emulator workflow, then unregister the session.
      const runsRes = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/android-emulator.yml/runs?status=in_progress&per_page=10`, { headers: ghHeaders });
      let cancelled = 0;
      if (runsRes.ok) {
        const { workflow_runs: runs = [] } = await runsRes.json();
        for (const run of runs) {
          const cancel = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}/cancel`, { method: 'POST', headers: ghHeaders });
          if (cancel.status === 202) cancelled++;
        }
      }
      await env.DB.prepare('DELETE FROM emulator_sessions WHERE id = ?').bind('default').run();
      await env.SESSION_KV.delete('emulator:default');
      return Response.json({ ok: true, message: `Emulator stopped (${cancelled} run(s) cancelled).`, cancelled }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/frontend/chat - talk to the VEXA agent directly.
  // Replies are grounded in the live device frame when one is available, so the
  // agent can describe what is actually on screen and queue a device action.
  if (path === '/api/frontend/chat' && method === 'POST') {
    try {
      const body = await request.json();
      const message = String(body.message || '').trim();
      const automationId = body.automationId || null;
      if (!message) {
        return Response.json({ error: 'message required' }, { status: 400, headers: corsHeaders() });
      }

      const session = (await env.SESSION_KV.get('emulator:default'))
        ? JSON.parse(await env.SESSION_KV.get('emulator:default'))
        : await getEmulatorSession(env.DB);
      const state = await getDeviceState(env.DB);
      const online = !!session && session.status === 'online'
        && (Date.now() - new Date(session.lastHeartbeat || 0).getTime()) < 5 * 60 * 1000;
      const frameDataUrl = state?.lastScreenshotUrl || '';
      const hasFrame = !!frameDataUrl;

      // Attach the live frame to the vision model. Without this the model only
      // had text, so it invented what was on screen (it once described the home
      // screen while the device was on a Settings page). NVIDIA's API rejects
      // very large bodies, so an oversized frame falls back to the UI tree.
      const canAttach = online
        && /^data:image\/(png|jpe?g|webp);base64,/.test(frameDataUrl)
        && frameDataUrl.length < 6_000_000;

      // The UI tree gives the model element names and bounds it can ground on.
      let uiText = '';
      if (online && state?.uiHierarchy) {
        try {
          const raw = atob(state.uiHierarchy);
          if (!raw.startsWith('DUMPSYS_WINDOWS:')) {
            const labels = [...raw.matchAll(/text="([^"]+)"/g)]
              .map((m) => m[1].trim())
              .filter(Boolean);
            if (labels.length) uiText = `\nOn-screen text (from the accessibility tree): ${labels.slice(0, 60).join(' | ')}`;
          }
        } catch { /* not base64; ignore */ }
      }

      const deviceContext = online
        ? `The Android device is ONLINE (${session.deviceModel || 'Android'} ${session.androidVersion || ''}, ${session.resolution || '1080x2400'}).${canAttach ? ' A live screenshot of its current screen is attached — describe only what you can actually see in it.' : hasFrame ? ' A screenshot exists but could not be attached; rely on the on-screen text below.' : ' No screenshot is available yet.'}${uiText}`
        : 'The Android device is currently OFFLINE. You can still answer questions, but you cannot observe or control the phone right now.';

      const messages = [
        {
          role: 'system',
          content: `You are VEXA, an autonomous AI agent that operates a real Android phone. You are chatting with the operator.
${deviceContext}
Be concise and concrete. When the user asks you to do something on the phone and the device is online, describe the exact steps you will take, then finish your reply with a single line of the form:
ACTION: {"action":"tap|swipe|scroll|type|key|back|home|launch|wait","x":0,"y":0,"text":"","app":""}
Only include the ACTION line when you are actually taking a step on the device. Omit it for pure conversation.`,
        },
      ];

      if (body.history && Array.isArray(body.history)) {
        for (const h of body.history.slice(-8)) {
          if (h && h.role && h.content) messages.push({ role: h.role === 'agent' ? 'assistant' : 'user', content: String(h.content).slice(0, 2000) });
        }
      }
      if (canAttach) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: message },
            { type: 'image_url', image_url: { url: frameDataUrl } },
          ],
        });
      } else {
        messages.push({ role: 'user', content: message });
      }

      const ai = await askAi(env, { messages });
      if (!ai.ok) {
        return Response.json({ ok: false, error: ai.error }, { status: 502, headers: corsHeaders() });
      }

      // Pull an optional device action out of the reply.
      let reply = ai.content;
      let queuedAction = null;
      const actionMatch = reply.match(/ACTION:\s*(\{[\s\S]*?\})/);
      if (actionMatch) {
        reply = reply.replace(actionMatch[0], '').trim();
        try {
          const action = JSON.parse(actionMatch[1]);
          if (online && action && action.action) {
            await upsertDeviceState(env.DB, {
              lastAction: JSON.stringify(action),
              lastActionResult: 'pending',
            });
            queuedAction = action;
          }
        } catch { /* ignore malformed action */ }
      }

      if (automationId) {
        await saveChatMessage(env.DB, { id: `msg_${Date.now()}_u`, automationId, role: 'user', content: message, timestamp: new Date().toISOString() });
        await saveChatMessage(env.DB, { id: `msg_${Date.now()}_a`, automationId, role: 'agent', content: reply, timestamp: new Date().toISOString() });
      }

      return Response.json({
        ok: true, reply, provider: ai.provider, deviceOnline: online, queuedAction,
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
        // The frontend posts `apiKeys` (one per line); older clients used `apiKey`.
        apiKeyEncrypted: body.apiKeys || body.apiKey || '',
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