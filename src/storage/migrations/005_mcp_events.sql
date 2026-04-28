-- MCP optimizer telemetry — track tool counts and tokens saved per request.

CREATE TABLE IF NOT EXISTS mcp_events (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  session_id      TEXT,
  tools_before    INTEGER,
  tools_after     INTEGER,
  tokens_saved    INTEGER,
  query_excerpt   TEXT,
  created_at      INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS mcp_events_user_idx ON mcp_events (user_id);
CREATE INDEX IF NOT EXISTS mcp_events_created_at_idx ON mcp_events (created_at DESC);
