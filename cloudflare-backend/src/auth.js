/**
 * VEXA Authentication Module
 * Handles login, token validation, and access control
 */

export async function handleAuth(request, env, ctx, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // POST /api/auth/login - authenticate user
  if (path === '/api/auth/login' && method === 'POST') {
    try {
      const body = await request.json();
      const { email, password } = body;

      if (!email || !password) {
        return Response.json({ error: 'Email and password required' }, { status: 400, headers: corsHeaders() });
      }

      // Look up user in D1
      const { results } = await env.DB.prepare(
        'SELECT * FROM users WHERE email = ?'
      ).bind(email).first();

      if (!results) {
        // Create demo user if not exists (for testing)
        const userId = `user_${crypto.randomUUID()}`;
        await env.DB.prepare(
          'INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(userId, email, email.split('@')[0], new Date().toISOString(), new Date().toISOString()).run();

        const token = crypto.randomUUID();
        await env.CONFIG_KV.put(`access_token:${token}`, JSON.stringify({
          type: 'user',
          userId,
          email,
        }), { expirationTtl: 86400 * 30 }); // 30 days

        return Response.json({
          ok: true,
          token,
          user: { id: userId, email, name: email.split('@')[0] },
        }, { headers: corsHeaders() });
      }

      const token = crypto.randomUUID();
      await env.CONFIG_KV.put(`access_token:${token}`, JSON.stringify({
        type: 'user',
        userId: results.id,
        email: results.email,
      }), { expirationTtl: 86400 * 30 });

      return Response.json({
        ok: true,
        token,
        user: { id: results.id, email: results.email, name: results.name },
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // POST /api/auth/verify - verify a token
  if (path === '/api/auth/verify' && method === 'POST') {
    try {
      const body = await request.json();
      const { token } = body;

      if (!token) {
        return Response.json({ error: 'Token required' }, { status: 400, headers: corsHeaders() });
      }

      const stored = await env.CONFIG_KV.get(`access_token:${token}`);
      if (!stored) {
        return Response.json({ valid: false }, { status: 401, headers: corsHeaders() });
      }

      return Response.json({ valid: true, data: JSON.parse(stored) }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }

  // GET /api/auth/me - get current user
  if (path === '/api/auth/me' && method === 'GET') {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return Response.json({ error: 'No token' }, { status: 401, headers: corsHeaders() });
    }
    const token = auth.substring(7);
    const stored = await env.CONFIG_KV.get(`access_token:${token}`);
    if (!stored) {
      return Response.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders() });
    }
    return Response.json({ ok: true, user: JSON.parse(stored) }, { headers: corsHeaders() });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}
