-- Patterns table — Golden Loop memory.
-- Vector storage uses a separate vec_patterns virtual table built via sqlite-vec.
-- If sqlite-vec is unavailable, the QueryBuilder falls back to a JS-cosine scan.

CREATE TABLE IF NOT EXISTS patterns (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  title         TEXT,
  problem       TEXT NOT NULL,
  solution      TEXT NOT NULL,
  -- SQLite has no array type; tags are stored as JSON-encoded text.
  tags          TEXT,
  -- embedding stored as JSON array of floats. The vec_patterns virtual table
  -- (when sqlite-vec is loaded) holds the same vectors keyed by rowid.
  embedding     TEXT,
  success_rate  REAL DEFAULT 1.0,
  applied_count INTEGER DEFAULT 0,
  created_at    INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS patterns_user_id_idx ON patterns (user_id);
CREATE INDEX IF NOT EXISTS patterns_created_at_idx ON patterns (created_at DESC);
