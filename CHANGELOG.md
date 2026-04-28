# Changelog

All notable changes to prxy-local will be documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-27

### Initial public release

Initial source release of the open-source local edition of prxy.monster.
Extracted from the prxy.monster cloud monorepo, with all cloud-only code
stripped out, and a new `airgap` module added.

#### Added

- Express gateway exposing Anthropic-compatible (`POST /v1/messages`) and
  OpenAI-compatible (`POST /v1/chat/completions`) endpoints.
- `GET /v1/pipeline` — introspect the active module pipeline.
- `GET /health` — liveness + provider config.
- Single-process SQLite storage adapter (better-sqlite3) with optional
  sqlite-vec for native vector search; falls back to a JS-cosine scan when
  sqlite-vec isn't available.
- In-memory KV store with TTL cleanup, filesystem blob store under
  `<PRXY_DATA_DIR>/blobs/`.
- Five SQL migrations covering: patterns, semantic_cache, sessions,
  eviction_cache, mcp_events. Migrations apply automatically on init.
- Seven built-in modules:
  - **mcp-optimizer** — embed-and-prune MCP tools by relevance.
  - **semantic-cache** — vector-similarity cache hits.
  - **exact-cache** — sha256-keyed cache hits.
  - **patterns** — Golden Loop: inject relevant past patterns + forge new
    ones from `the issue was X / fix is Y` markers.
  - **ipc** — Inter-Prompt Compression that summarizes older messages once
    the request crosses a context utilization threshold.
  - **cost-guard** — per-request, per-day, per-month USD budget caps.
  - **airgap** — *new in local*: monkey-patches `globalThis.fetch` once at
    boot to block all outbound network calls except to a configurable list
    of provider hosts.
- Optional `LOCAL_API_KEY` Bearer auth for the gateway. Unset = open mode.
- Docker single-image build and `docker-compose.yml` for one-command local dev.
- `Makefile` with `up`, `down`, `logs`, `build`, `test`, `migrate` targets.
- `prxy` CLI: `export`, `import`, `patterns list`, `patterns clear`, `cache
  clear`, `migrate`.
- Vitest test suite covering: pipeline executor + loader, every module,
  storage parity, integration end-to-end through Express, airgap.
- CI workflow that runs `npm ci`, `npm run build`, `npm test` on every push
  and PR to `main`.

#### What's NOT here (cloud-only)

- Billing / Stripe integration.
- User signup / API key issuance flow.
- Postgres + Upstash + R2 cloud storage adapters.
- Web dashboard, docs site, marketing pages.
- `usage-tracker` module (cloud billing only — local users use `cost-guard`
  for budget caps).

#### Notes

- `@prxy/module-sdk` is currently inlined under `src/types/`. A future
  release will publish it to npm so prxy-local and the cloud edition can
  share the contract.
- Google + Groq provider clients are stubs that throw. PRs welcome — the
  OpenAI client is a good reference shape.
