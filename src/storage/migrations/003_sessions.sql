-- Sessions table — tracks logical conversation sessions for IPC eviction.

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  api_key_id  TEXT,
  created_at  INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  expires_at  INTEGER,
  metadata    TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
