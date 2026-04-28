-- Semantic cache — embeds + responses for vector-search-based cache hits.

CREATE TABLE IF NOT EXISTS semantic_cache (
  id          TEXT PRIMARY KEY,
  embedding   TEXT,
  response    TEXT NOT NULL,
  model       TEXT,
  created_at  INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS semantic_cache_created_at_idx ON semantic_cache (created_at DESC);
