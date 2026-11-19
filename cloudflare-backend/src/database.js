/**
 * VEXA Database Initialization
 * D1 database schema for the VEXA platform
 */

function snakeToCamel(obj) {
  if (obj === null || obj === undefined) return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

export async function initDatabase(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, avatar_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY DEFAULT 'default', gateway_url TEXT, provider TEXT DEFAULT 'nvidia', model TEXT DEFAULT 'nemotron-3.5-super-vl-120b-a12b', api_key_encrypted TEXT, github_pat_encrypted TEXT, github_repo TEXT, cloudflare_account_id TEXT, cloudflare_api_token_encrypted TEXT, key_rotation INTEGER DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, schedule_type TEXT DEFAULT 'once', interval_minutes INTEGER DEFAULT 60, enabled INTEGER DEFAULT 1, paused INTEGER DEFAULT 0, status TEXT DEFAULT 'queued', next_run_at TEXT, last_run_at TEXT, last_run_status TEXT, run_count INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP, execution_id TEXT, FOREIGN KEY (automation_id) REFERENCES automations(id))`);
  await db.exec(`CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT DEFAULT CURRENT_TIMESTAMP, finished_at TEXT, task_received TEXT, actions_performed TEXT, apps_interacted TEXT, observed_results TEXT, outcome_achieved INTEGER DEFAULT 0, failures TEXT, checkpoints TEXT, next_execution_scheduled TEXT, resuming INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (automation_id) REFERENCES automations(id))`);
  await db.exec(`CREATE TABLE IF NOT EXISTS emulator_sessions (id TEXT PRIMARY KEY, gateway_url TEXT NOT NULL, status TEXT DEFAULT 'offline', device_model TEXT, android_version TEXT, resolution TEXT, logged_in_account TEXT, active_run_id TEXT, last_heartbeat TEXT, registered_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS device_state (id TEXT PRIMARY KEY DEFAULT 'current', screen_checksum TEXT, last_screenshot_url TEXT, last_action TEXT, last_action_result TEXT, ui_hierarchy TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  // Add ui_hierarchy column to existing databases (SQLite doesn't support ADD COLUMN IF NOT EXISTS)
  try { await db.exec(`ALTER TABLE device_state ADD COLUMN ui_hierarchy TEXT`); } catch { /* column may already exist */ }
  // Weak-network support: a downscaled JPEG variant alongside the full PNG so a
  // client on a slow link can fetch a small frame instead of a multi-megabyte one.
  try { await db.exec(`ALTER TABLE device_state ADD COLUMN last_screenshot_small_url TEXT`); } catch { /* exists */ }
  // Correlate a queued action with its result so the UI can refresh the instant
  // the device executed it, and so a duplicate command can be recognised.
  try { await db.exec(`ALTER TABLE device_state ADD COLUMN last_action_client_id TEXT`); } catch { /* exists */ }
  try { await db.exec(`ALTER TABLE device_state ADD COLUMN last_action_status TEXT`); } catch { /* exists */ }
  await db.exec(`CREATE TABLE IF NOT EXISTS provider_usage (id TEXT PRIMARY KEY DEFAULT 'default', provider TEXT NOT NULL, requests_count INTEGER DEFAULT 0, errors_count INTEGER DEFAULT 0, last_used TEXT, rate_limited_until TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  // A conversation is a chat thread. `chats.automation_id` doubles as the
  // conversation id so existing message rows keep working; `conversations`
  // carries the title, timestamps and automation link the sidebar needs.
  await db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat', automation_id TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  // `chats` carried a FOREIGN KEY to automations, so a conversation that is not
  // an automation could not store messages ("FOREIGN KEY constraint failed").
  // chat_messages has no such constraint; conversations are the parent now.
  await db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP, execution_id TEXT)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, timestamp)`);
  // Agent activity events: the live "what is the agent doing right now" feed.
  // Every real step (plan, tool call, observation, error, verification) is
  // appended here by the agent runner; the frontend streams them via SSE. Events
  // are only ever written by the runtime that performed the action — never
  // fabricated by the frontend.
  await db.exec(`CREATE TABLE IF NOT EXISTS agent_events (id TEXT PRIMARY KEY, conversation_id TEXT, automation_id TEXT, execution_id TEXT, kind TEXT NOT NULL, title TEXT, detail TEXT, status TEXT DEFAULT 'info', seq INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  // Access tokens: D1 is the source of truth. KV writes are capped (1,000/day on
  // this plan) and a 429 there silently logged users out; a D1 row cannot be
  // rate-limited away. Existing KV tokens are carried over on boot.
  await db.exec(`CREATE TABLE IF NOT EXISTS access_tokens (token TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_events_conversation ON agent_events(conversation_id, seq)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_events_automation ON agent_events(automation_id, seq)`);
  // One-time carry-over of any messages written to the old table.
  await db.exec(`INSERT OR IGNORE INTO chat_messages (id, conversation_id, role, content, timestamp, execution_id) SELECT id, automation_id, role, content, timestamp, execution_id FROM chats`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_automation_id ON chats(automation_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_timestamp ON chats(timestamp)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_automation_id ON executions(automation_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_created_at ON executions(created_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_automations_status ON automations(status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_emulator_sessions_status ON emulator_sessions(status)`);
}

/**
 * Persist an access token. `payload` is the JSON-serialisable token record
 * ({ type, userId, email, ... }) that used to be written to KV.
 */
export async function createAccessToken(db, token, payload, { ttlSeconds = 86400 * 30 } = {}) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await db.prepare(
    `INSERT INTO access_tokens (token, payload, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`
  ).bind(token, JSON.stringify(payload), expiresAt).run();
  return payload;
}

/** Look up an unexpired access token; returns the parsed payload or null. */
export async function getAccessToken(db, token) {
  if (!token) return null;
  const row = await db.prepare('SELECT payload, expires_at FROM access_tokens WHERE token = ?').bind(token).first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/**
 * Carry KV-stored tokens into D1 once. Idempotent: existing rows are left alone.
 * KV listing is a read (not a write) so this costs no write budget.
 */
export async function migrateTokensFromKv(db, kv) {
  if (!db || !kv || typeof kv.list !== 'function') return { migrated: 0 };
  let migrated = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix: 'access_token:', cursor });
    for (const key of page.keys || []) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      const token = key.name.slice('access_token:'.length);
      try {
        await db.prepare(
          `INSERT OR IGNORE INTO access_tokens (token, payload, expires_at) VALUES (?, ?, ?)`
        ).bind(token, raw, new Date(Date.now() + 86400 * 30 * 1000).toISOString()).run();
        migrated += 1;
      } catch { /* row already present */ }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { migrated };
}

export async function getAutomations(db) {
  const { results } = await db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all();
  return results.map(snakeToCamel);
}

export async function getAutomation(db, id) {
  const result = await db.prepare('SELECT * FROM automations WHERE id = ?').bind(id).first();
  return result ? snakeToCamel(result) : null;
}

export async function upsertAutomation(db, automation) {
  const existing = await db.prepare('SELECT id FROM automations WHERE id = ?').bind(automation.id).first();
  if (existing) {
    await db.prepare(`UPDATE automations SET name = ?, instructions = ?, schedule_type = ?, interval_minutes = ?, enabled = ?, paused = ?, status = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, run_count = ?, updated_at = ? WHERE id = ?`).bind(
      automation.name,
      automation.instructions,
      automation.scheduleType,
      automation.intervalMinutes,
      automation.enabled ? 1 : 0,
      automation.paused ? 1 : 0,
      automation.status,
      automation.nextRunAt,
      automation.lastRunAt,
      automation.lastRunStatus || '',
      automation.runCount,
      automation.updatedAt,
      automation.id
    ).run();
  } else {
    await db.prepare(`INSERT INTO automations (id, name, instructions, schedule_type, interval_minutes, enabled, paused, status, next_run_at, last_run_at, last_run_status, run_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      automation.id,
      automation.name,
      automation.instructions,
      automation.scheduleType,
      automation.intervalMinutes,
      automation.enabled ? 1 : 0,
      automation.paused ? 1 : 0,
      automation.status,
      automation.nextRunAt,
      automation.lastRunAt,
      automation.lastRunStatus || '',
      automation.runCount,
      automation.createdAt,
      automation.updatedAt
    ).run();
  }
}

export async function saveExecution(db, execution) {
  await db.prepare(`INSERT INTO executions (id, automation_id, status, started_at, finished_at, task_received, actions_performed, apps_interacted, observed_results, outcome_achieved, failures, checkpoints, next_execution_scheduled, resuming, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    execution.id,
    execution.automationId,
    execution.status,
    execution.startedAt,
    execution.finishedAt,
    execution.taskReceived,
    JSON.stringify(execution.actionsPerformed || []),
    JSON.stringify(execution.appsInteracted || []),
    execution.observedResults,
    execution.outcomeAchieved ? 1 : 0,
    execution.failures,
    JSON.stringify(execution.checkpoints || []),
    execution.nextExecutionScheduled,
    execution.resuming ? 1 : 0,
    new Date().toISOString()
  ).run();
}

export async function saveChatMessage(db, message) {
  await db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, execution_id) VALUES (?, ?, ?, ?, ?, ?)`).bind(
    message.id,
    message.automationId,
    message.role,
    message.content,
    message.timestamp,
    message.executionId || null
  ).run();
}

export async function getChats(db, conversationId, limit = 100) {
  const { results } = await db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?').bind(conversationId, limit).all();
  return results.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    timestamp: r.timestamp,
    executionId: r.execution_id || null,
  })).reverse();
}

export async function listExecutions(db, automationId, limit = 50) {
  const { results } = await db.prepare(
    'SELECT * FROM executions WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(automationId, limit).all();
  return results.map((r) => ({
    id: r.id,
    automationId: r.automation_id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    taskReceived: r.task_received,
    actionsPerformed: safeParseArray(r.actions_performed),
    appsInteracted: safeParseArray(r.apps_interacted),
    observedResults: r.observed_results,
    outcomeAchieved: r.outcome_achieved === 1,
    failures: r.failures,
    checkpoints: safeParseArray(r.checkpoints),
    nextExecutionScheduled: r.next_execution_scheduled,
    resuming: r.resuming === 1,
    createdAt: r.created_at,
  }));
}

function safeParseArray(value) {
  if (!value) return [];
  try { const v = JSON.parse(value); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function getEmulatorSession(db) {
  const result = await db.prepare('SELECT * FROM emulator_sessions ORDER BY updated_at DESC LIMIT 1').first();
  return result ? snakeToCamel(result) : null;
}

/**
 * Refresh only the heartbeat timestamp of the emulator session.
 *
 * A heartbeat is a liveness ping, not a state change, so it must not rewrite the
 * whole row (or the KV mirror). The UPDATE is skipped when the stored beat is
 * younger than `minIntervalMs` — the emulator beats every 30s and the UI treats
 * anything under 5 minutes as online, so a 60s floor loses no freshness while
 * cutting the write rate in half.
 *
 * @returns {Promise<boolean>} true when a write happened
 */
export async function touchEmulatorHeartbeat(db, { minIntervalMs = 60 * 1000 } = {}) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - minIntervalMs).toISOString();
  const res = await db.prepare(
    `UPDATE emulator_sessions SET last_heartbeat = ?, updated_at = ?
     WHERE id = 'default' AND (last_heartbeat IS NULL OR last_heartbeat < ?)`
  ).bind(now, now, cutoff).run();
  return (res?.meta?.changes || 0) > 0;
}

export async function upsertEmulatorSession(db, session) {
  const id = session.id || 'default';
  const existing = await db.prepare('SELECT id FROM emulator_sessions WHERE id = ?').bind(id).first();
  if (existing) {
    await db.prepare(`UPDATE emulator_sessions SET gateway_url = ?, status = ?, device_model = ?, android_version = ?, resolution = ?, logged_in_account = ?, active_run_id = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?`).bind(
      session.gatewayUrl,
      session.status,
      session.deviceModel,
      session.androidVersion,
      session.resolution,
      session.loggedInAccount,
      session.activeRunId,
      session.lastHeartbeat,
      new Date().toISOString(),
      id
    ).run();
  } else {
    await db.prepare(`INSERT INTO emulator_sessions (id, gateway_url, status, device_model, android_version, resolution, logged_in_account, active_run_id, last_heartbeat, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      session.gatewayUrl,
      session.status,
      session.deviceModel,
      session.androidVersion,
      session.resolution,
      session.loggedInAccount,
      session.activeRunId,
      session.lastHeartbeat,
      session.registeredAt || new Date().toISOString(),
      new Date().toISOString()
    ).run();
  }
}

export async function getSettings(db) {
  const result = await db.prepare('SELECT * FROM settings WHERE id = ?').bind('default').first();
  return result ? snakeToCamel(result) : null;
}

export async function upsertSettings(db, settings) {
  const bindValues = [
    'default',
    settings.gatewayUrl,
    settings.provider,
    settings.model,
    settings.apiKeyEncrypted,
    settings.githubPatEncrypted,
    settings.githubRepo,
    settings.cloudflareAccountId,
    settings.cloudflareApiTokenEncrypted,
    settings.keyRotation ? 1 : 0,
    new Date().toISOString(),
  ];
  for (let i = 0; i < bindValues.length; i++) {
    if (bindValues[i] === undefined) {
      console.error(`upsertSettings: bind value ${i} is undefined`);
    }
  }

  const existing = await db.prepare('SELECT id FROM settings WHERE id = ?').bind('default').first();
  if (existing) {
    await db.prepare(`UPDATE settings SET gateway_url = ?, provider = ?, model = ?, api_key_encrypted = ?, github_pat_encrypted = ?, github_repo = ?, cloudflare_account_id = ?, cloudflare_api_token_encrypted = ?, key_rotation = ?, updated_at = ? WHERE id = ?`).bind(
      settings.gatewayUrl,
      settings.provider,
      settings.model,
      settings.apiKeyEncrypted,
      settings.githubPatEncrypted,
      settings.githubRepo,
      settings.cloudflareAccountId,
      settings.cloudflareApiTokenEncrypted,
      settings.keyRotation ? 1 : 0,
      new Date().toISOString(),
      'default'
    ).run();
  } else {
    await db.prepare(`INSERT INTO settings (id, gateway_url, provider, model, api_key_encrypted, github_pat_encrypted, github_repo, cloudflare_account_id, cloudflare_api_token_encrypted, key_rotation, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...bindValues).run();
  }
}

export async function getDeviceState(db) {
  const result = await db.prepare('SELECT * FROM device_state WHERE id = ?').bind('current').first();
  return result ? snakeToCamel(result) : null;
}

export async function upsertDeviceState(db, state) {
  // Partial update: only the fields actually present in `state` are written.
  // The previous implementation wrote every column on every call, so queueing an
  // action (which passes only lastAction/lastActionResult) blanked the screenshot
  // and UI hierarchy, and uploading a screenshot blanked the pending action. The
  // agent therefore never saw a frame and the emulator never saw an action.
  const existing = await db.prepare('SELECT * FROM device_state WHERE id = ?').bind('current').first();
  const has = (key) => Object.prototype.hasOwnProperty.call(state, key);
  const current = existing ? snakeToCamel(existing) : {};

  const merged = {
    screenChecksum: has('screenChecksum') ? state.screenChecksum : (current.screenChecksum ?? null),
    lastScreenshotUrl: has('lastScreenshotUrl') ? state.lastScreenshotUrl : (current.lastScreenshotUrl ?? null),
    lastScreenshotSmallUrl: has('lastScreenshotSmallUrl') ? state.lastScreenshotSmallUrl : (current.lastScreenshotSmallUrl ?? null),
    lastAction: has('lastAction') ? state.lastAction : (current.lastAction ?? null),
    lastActionResult: has('lastActionResult') ? state.lastActionResult : (current.lastActionResult ?? null),
    lastActionClientId: has('lastActionClientId') ? state.lastActionClientId : (current.lastActionClientId ?? null),
    lastActionStatus: has('lastActionStatus') ? state.lastActionStatus : (current.lastActionStatus ?? null),
    uiHierarchy: has('uiHierarchy') ? state.uiHierarchy : (current.uiHierarchy ?? null),
  };

  if (existing) {
    await db.prepare(`UPDATE device_state SET screen_checksum = ?, last_screenshot_url = ?, last_screenshot_small_url = ?, last_action = ?, last_action_result = ?, last_action_client_id = ?, last_action_status = ?, ui_hierarchy = ?, updated_at = ? WHERE id = ?`).bind(
      merged.screenChecksum,
      merged.lastScreenshotUrl,
      merged.lastScreenshotSmallUrl,
      merged.lastAction,
      merged.lastActionResult,
      merged.lastActionClientId,
      merged.lastActionStatus,
      merged.uiHierarchy,
      // updated_at tracks frame freshness, so it only advances when a new frame
      // (or UI tree) actually arrives. Queueing an action must not make a stale
      // screenshot look fresh.
      has('lastScreenshotUrl') || has('uiHierarchy') || has('screenChecksum')
        ? new Date().toISOString()
        : (current.updatedAt ?? new Date().toISOString()),
      'current'
    ).run();
  } else {
    await db.prepare(`INSERT INTO device_state (id, screen_checksum, last_screenshot_url, last_screenshot_small_url, last_action, last_action_result, last_action_client_id, last_action_status, ui_hierarchy, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      'current',
      merged.screenChecksum,
      merged.lastScreenshotUrl,
      merged.lastScreenshotSmallUrl,
      merged.lastAction,
      merged.lastActionResult,
      merged.lastActionClientId,
      merged.lastActionStatus,
      merged.uiHierarchy,
      new Date().toISOString()
    ).run();
  }
}

/**
 * Atomically claim a queued action for a client id.
 *
 * The read-then-write check in the handler is not enough: two taps fired
 * back-to-back on a laggy link both read the pre-claim state and both queue a
 * device command, so the phone acted twice. A conditional UPDATE makes the
 * claim atomic — only the statement that sees no pending action for this client
 * id changes a row, and D1 reports that as a single changed row.
 *
 * Returns true when this caller won the claim.
 */
export async function claimDeviceAction(db, { action, clientId }) {
  // One statement for both cases. When clientId is null the condition reduces to
  // "always claim"; when it is set, a pending action with the same id blocks it.
  const result = await db.prepare(
    `UPDATE device_state
        SET last_action = ?, last_action_result = 'pending', last_action_client_id = ?, last_action_status = 'pending'
      WHERE id = 'current'
        AND (last_action_status IS NULL OR last_action_status != 'pending' OR last_action_client_id IS NULL OR last_action_client_id IS NOT ? OR last_action_client_id != ?)`
  ).bind(JSON.stringify(action), clientId, clientId, clientId).run();
  return (result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

/* ---------------------------------------------------------- agent activity events */

export async function appendAgentEvent(db, event) {
  // seq is a monotonically increasing counter per conversation so the frontend
  // can order events deterministically even when timestamps collide.
  let seq = event.seq;
  if (seq === undefined || seq === null) {
    const row = await db.prepare(
      `SELECT MAX(seq) AS maxSeq FROM agent_events WHERE conversation_id IS ? AND automation_id IS ?`
    ).bind(event.conversationId || null, event.automationId || null).first();
    seq = Number(row?.maxSeq || 0) + 1;
  }
  await db.prepare(
    `INSERT INTO agent_events (id, conversation_id, automation_id, execution_id, kind, title, detail, status, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    event.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    event.conversationId || null,
    event.automationId || null,
    event.executionId || null,
    event.kind || 'info',
    event.title || '',
    event.detail || '',
    event.status || 'info',
    seq,
    event.createdAt || new Date().toISOString()
  ).run();
  return seq;
}

export async function listAgentEvents(db, { conversationId, automationId, afterSeq = 0, limit = 200 } = {}) {
  let sql = 'SELECT * FROM agent_events WHERE seq > ?';
  const binds = [afterSeq];
  if (conversationId) { sql += ' AND conversation_id = ?'; binds.push(conversationId); }
  if (automationId) { sql += ' AND automation_id = ?'; binds.push(automationId); }
  sql += ' ORDER BY seq ASC LIMIT ?';
  binds.push(limit);
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id || null,
    automationId: r.automation_id || null,
    executionId: r.execution_id || null,
    kind: r.kind,
    title: r.title || '',
    detail: r.detail || '',
    status: r.status || 'info',
    seq: Number(r.seq || 0),
    createdAt: r.created_at,
  }));
}
/* ------------------------------------------------------------------ conversations */

export async function listConversations(db, limit = 100) {
  const { results } = await db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`
  ).bind(limit).all();
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    automationId: r.automation_id || null,
    status: r.status || 'active',
    messageCount: Number(r.message_count || 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getConversation(db, id) {
  const row = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first();
  return row ? snakeToCamel(row) : null;
}

export async function upsertConversation(db, conv) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO conversations (id, title, automation_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = COALESCE(excluded.title, conversations.title),
       automation_id = COALESCE(excluded.automation_id, conversations.automation_id),
       status = COALESCE(excluded.status, conversations.status),
       updated_at = excluded.updated_at`
  ).bind(
    conv.id,
    conv.title || 'New chat',
    conv.automationId || null,
    conv.status || 'active',
    conv.createdAt || now,
    conv.updatedAt || now
  ).run();
  return getConversation(db, conv.id);
}

export async function renameConversation(db, id, title) {
  await db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .bind(title, new Date().toISOString(), id).run();
  return getConversation(db, id);
}

export async function deleteConversation(db, id) {
  await db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').bind(id).run();
  await db.prepare('DELETE FROM conversations WHERE id = ?').bind(id).run();
}

/** Touch a conversation so the sidebar sorts by real last activity. */
export async function touchConversation(db, id) {
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), id).run();
}
