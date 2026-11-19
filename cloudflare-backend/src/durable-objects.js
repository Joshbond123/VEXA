/**
 * VEXA Durable Objects - Live Emulator Session Management
 */

import { kvPutJson } from './kv.js';

export class EmulatorSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.emulatorData = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // POST /api/session/register - register emulator
    if (path === '/api/session/register' && method === 'POST') {
      try {
        const body = await request.json();
        this.emulatorData = {
          ...body,
          status: 'online',
          registeredAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        };

        // Persist to D1
        if (this.env.DB) {
          await this.env.DB.prepare(`INSERT INTO emulator_sessions (id, gateway_url, status, device_model, android_version, resolution, logged_in_account, active_run_id, last_heartbeat, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET gateway_url = excluded.gateway_url, status = excluded.status, device_model = excluded.device_model, android_version = excluded.android_version, resolution = excluded.resolution, logged_in_account = excluded.logged_in_account, active_run_id = excluded.active_run_id, last_heartbeat = excluded.last_heartbeat, updated_at = excluded.updated_at`).bind(
            'default',
            body.gatewayUrl,
            'online',
            body.deviceModel,
            body.androidVersion,
            body.resolution,
            body.loggedInAccount,
            body.activeRunId,
            new Date().toISOString(),
            new Date().toISOString()
          ).run();
        }

        // Cache in KV (deduped + throttled by the shared wrapper).
        if (this.env.SESSION_KV) {
          await kvPutJson(this.env.SESSION_KV, 'emulator:default', this.emulatorData, {
            expirationTtl: 3600,
            minIntervalMs: 60 * 60 * 1000,
          });
        }

        return Response.json({ ok: true, message: 'Emulator registered' });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/session/heartbeat - update heartbeat
    if (path === '/api/session/heartbeat' && method === 'POST') {
      try {
        if (this.emulatorData) {
          this.emulatorData.lastHeartbeat = new Date().toISOString();
          this.emulatorData.status = 'online';
        }
        // No KV write here. The Durable Object already holds the live session in
        // memory and mirrors it to D1 on register; writing the cache on every
        // heartbeat is what pushed the account over the daily KV write cap.
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // GET /api/session/state - get emulator state
    if (path === '/api/session/state' && method === 'GET') {
      return Response.json({ ok: true, session: this.emulatorData });
    }

    // POST /api/session/action - send action to emulator
    if (path === '/api/session/action' && method === 'POST') {
      try {
        const body = await request.json();
        this.emulatorData = {
          ...(this.emulatorData || {}),
          lastAction: body,
          lastActionAt: new Date().toISOString(),
        };
        return Response.json({ ok: true, action: body.action });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
}
