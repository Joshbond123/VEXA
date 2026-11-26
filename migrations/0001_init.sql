CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_operator ON sessions(operator_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  secret_enc TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  requests INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  job_id TEXT,
  key_id TEXT,
  status TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  chars INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts DESC);

CREATE TABLE IF NOT EXISTS gpu_sessions (
  id TEXT PRIMARY KEY,
  kernel_version TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ready_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  gpu_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gpu_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT, phase TEXT, detail TEXT, session_id TEXT, kernel_version INTEGER,
  started_at INTEGER, allocated_at INTEGER, ready_at INTEGER, last_heartbeat INTEGER,
  last_activity INTEGER, active_jobs INTEGER, progress REAL, gpus_json TEXT,
  model_json TEXT, error TEXT, stop_reason TEXT, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gpu_sessions_started ON gpu_sessions(started_at DESC);
