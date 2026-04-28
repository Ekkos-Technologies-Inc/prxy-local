-- Eviction cache — IPC archives older messages and points at the blob keys here.

CREATE TABLE IF NOT EXISTS eviction_cache (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  user_id     TEXT,
  blob_key    TEXT,
  summary     TEXT,
  evicted_at  INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  tokens      INTEGER
);

CREATE INDEX IF NOT EXISTS eviction_cache_session_idx ON eviction_cache (session_id);
CREATE INDEX IF NOT EXISTS eviction_cache_user_idx ON eviction_cache (user_id);
