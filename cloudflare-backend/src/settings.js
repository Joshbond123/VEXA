/**
 * VEXA Settings Module
 * Handles configuration management with connection testing
 * Uses KV for storage (reliable, no D1 bind issues)
 */

export async function handleSettings(request, env, ctx, token, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // GET /api/settings - get all settings
  if (path === '/api/settings' && method === 'GET') {
    try {
      const kvConfig = await env.CONFIG_KV.get('settings_config');
      
      if (!kvConfig) {
        return Response.json({ 
          ok: true, 
          settings: { 
            provider: 'nvidia', 
            keyRotation: true,
            configured: false 
          } 
        }, { headers: corsHeaders() });
      }
      
      const config = JSON.parse(kvConfig);
      return Response.json({ 
        ok: true, 
        settings: {
          gatewayUrl: config.gatewayUrl || '',
          provider: config.provider || 'nvidia',
          model: config.model || 'nemotron-3.5-super-vl-120b-a12b',
          keyRotation: config.keyRotation !== false,
          hasApiKey: !!config.apiKeyEncrypted,
          hasGitHubPat: !!config.githubPatEncrypted,
          githubRepo: config.githubRepo || '',
          cloudflareAccountId: config.cloudflareAccountId || '',
          hasCloudflareToken: !!config.cloudflareApiTokenEncrypted,
          configured: true,
        } 
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/settings - save settings
  if (path === '/api/settings' && method === 'POST') {
    try {
      const body = await request.json();
      
      // Save to KV
      await env.CONFIG_KV.put('settings_config', JSON.stringify({
        gatewayUrl: body.gatewayUrl || '',
        provider: body.provider || 'nvidia',
        model: body.model || 'nemotron-3.5-super-vl-120b-a12b',
        apiKeyEncrypted: body.apiKey || '',
        githubPatEncrypted: body.githubPat || '',
        githubRepo: body.githubRepo || '',
        cloudflareAccountId: body.cloudflareAccountId || '',
        cloudflareApiTokenEncrypted: body.cloudflareApiToken || '',
        keyRotation: body.keyRotation !== false,
      }), { expirationTtl: 86400 * 30 });

      return Response.json({ ok: true, message: 'Settings saved successfully' }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/settings/test-ai - test AI provider connection
  if (path === '/api/settings/test-ai' && method === 'POST') {
    try {
      const body = await request.json();
      const { provider, apiKey, model } = body;

      if (!provider || !apiKey) {
        return Response.json({ error: 'Provider and API key required' }, { status: 400, headers: corsHeaders() });
      }

      let testEndpoint, testModel, testHeaders;
      
      if (provider === 'nvidia') {
        testEndpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
        testModel = model || 'nvidia/nemotron-3.5-super-vl-120b-a12b';
        testHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      } else if (provider === 'grok') {
        testEndpoint = 'https://api.x.ai/v1/chat/completions';
        testModel = model || 'grok-2-vision-1212';
        testHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      } else if (provider === 'openai') {
        testEndpoint = body.endpoint || 'https://api.openai.com/v1/chat/completions';
        testModel = model || 'gpt-4o-mini';
        testHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      } else {
        return Response.json({ error: 'Unknown provider' }, { status: 400, headers: corsHeaders() });
      }

      try {
        const res = await fetch(testEndpoint, {
          method: 'POST',
          headers: testHeaders,
          body: JSON.stringify({
            model: testModel,
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 10,
          }),
        });

        if (res.ok) {
          return Response.json({ 
            ok: true, 
            message: `${provider} connection successful`,
            provider,
            model: testModel,
          }, { headers: corsHeaders() });
        } else {
          const errorText = await res.text().catch(() => '');
          return Response.json({ 
            ok: false, 
            message: `${provider} connection failed: ${res.status} ${errorText}`,
            provider,
          }, { status: 400, headers: corsHeaders() });
        }
      } catch (fetchErr) {
        return Response.json({ 
          ok: false, 
          message: `${provider} connection error: ${fetchErr.message}`,
          provider,
        }, { status: 400, headers: corsHeaders() });
      }
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/settings/test-github - test GitHub PAT
  if (path === '/api/settings/test-github' && method === 'POST') {
    try {
      const body = await request.json();
      const { githubPat, githubRepo } = body;

      if (!githubPat) {
        return Response.json({ error: 'GitHub PAT required' }, { status: 400, headers: corsHeaders() });
      }

      const repo = githubRepo || 'Joshbond123/VEXA';
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}`, {
          headers: {
            Authorization: `Bearer ${githubPat}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'VEXA-Platform/1.0',
          },
        });

        if (res.ok) {
          const repoData = await res.json();
          const permissions = repoData.permissions || {};
          return Response.json({ 
            ok: true, 
            message: 'GitHub connection successful',
            repo: repoData.full_name,
            permissions: {
              admin: permissions.admin || false,
              push: permissions.push || false,
              pull: permissions.pull || false,
            },
          }, { headers: corsHeaders() });
        } else {
          const errorText = await res.text().catch(() => '');
          return Response.json({ 
            ok: false, 
            message: `GitHub connection failed: ${res.status} ${errorText}`,
          }, { status: 400, headers: corsHeaders() });
        }
      } catch (fetchErr) {
        return Response.json({ 
          ok: false, 
          message: `GitHub connection error: ${fetchErr.message}`,
        }, { status: 400, headers: corsHeaders() });
      }
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/settings/test-cloudflare - test Cloudflare API token
  if (path === '/api/settings/test-cloudflare' && method === 'POST') {
    try {
      const body = await request.json();
      const { cloudflareAccountId, cloudflareApiToken } = body;

      if (!cloudflareAccountId || !cloudflareApiToken) {
        return Response.json({ error: 'Cloudflare Account ID and API Token required' }, { status: 400, headers: corsHeaders() });
      }

      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}`, {
          headers: {
            Authorization: `Bearer ${cloudflareApiToken}`,
          },
        });

        if (res.ok) {
          const data = await res.json();
          return Response.json({ 
            ok: true, 
            message: 'Cloudflare connection successful',
            account: data.result?.name || cloudflareAccountId,
          }, { headers: corsHeaders() });
        } else {
          const errorText = await res.text().catch(() => '');
          return Response.json({ 
            ok: false, 
            message: `Cloudflare connection failed: ${res.status} ${errorText}`,
          }, { status: 400, headers: corsHeaders() });
        }
      } catch (fetchErr) {
        return Response.json({ 
          ok: false, 
          message: `Cloudflare connection error: ${fetchErr.message}`,
        }, { status: 400, headers: corsHeaders() });
      }
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}
