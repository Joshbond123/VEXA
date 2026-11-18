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
  await db.exec(`CREATE TABLE IF NOT EXISTS device_state (id TEXT PRIMARY KEY DEFAULT 'current', screen_checksum TEXT, last_screenshot_url TEXT, last_action TEXT, last_action_result TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS provider_usage (id TEXT PRIMARY KEY DEFAULT 'default', provider TEXT NOT NULL, requests_count INTEGER DEFAULT 0, errors_count INTEGER DEFAULT 0, last_used TEXT, rate_limited_until TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_automation_id ON chats(automation_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_timestamp ON chats(timestamp)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_automation_id ON executions(automation_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_created_at ON executions(created_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_automations_status ON automations(status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_emulator_sessions_status ON emulator_sessions(status)`);
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
  await db.prepare(`INSERT INTO chats (id, automation_id, role, content, timestamp, execution_id) VALUES (?, ?, ?, ?, ?, ?)`).bind(
    message.id,
    message.automationId,
    message.role,
    message.content,
    message.timestamp,
    message.executionId || null
  ).run();
}

export async function getChats(db, automationId, limit = 100) {
  const { results } = await db.prepare('SELECT * FROM chats WHERE automation_id = ? ORDER BY timestamp DESC LIMIT ?').bind(automationId, limit).all();
  return results.map(snakeToCamel).reverse();
}

export async function getEmulatorSession(db) {
  const result = await db.prepare('SELECT * FROM emulator_sessions ORDER BY updated_at DESC LIMIT 1').first();
  return result ? snakeToCamel(result) : null;
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
  const existing = await db.prepare('SELECT id FROM device_state WHERE id = ?').bind('current').first();
  if (existing) {
    await db.prepare(`UPDATE device_state SET screen_checksum = ?, last_screenshot_url = ?, last_action = ?, last_action_result = ?, updated_at = ? WHERE id = ?`).bind(
      state.screenChecksum || null,
      state.lastScreenshotUrl || null,
      state.lastAction || null,
      state.lastActionResult || null,
      new Date().toISOString(),
      'current'
    ).run();
  } else {
    await db.prepare(`INSERT INTO device_state (id, screen_checksum, last_screenshot_url, last_action, last_action_result, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(
      'current',
      state.screenChecksum || null,
      state.lastScreenshotUrl || null,
      state.lastAction || null,
      state.lastActionResult || null,
      new Date().toISOString()
    ).run();
  }
}