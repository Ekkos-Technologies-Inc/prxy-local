# Changelog

All notable changes to prxy-local will be documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-04-27

Multi-provider promise made good. Two new provider clients ship implemented (no
more "PRs welcome" stub-throwing), and four modules graduate from the v1.1
roadmap into v1.0 production.

### Added

- **Google (Gemini) provider client** via `@google/genai` (the unified post-2024 SDK):
  - Full canonical ↔ Gemini translation: `contents[]`/`role: 'model'`, `systemInstruction`, `functionDeclarations`, `functionCall`/`functionResponse` parts, `inlineData` for base64 images.
  - Streaming via `generateContentStream` — Gemini's full-response chunks are diffed into Anthropic-style `content_block_*` events so modules see the same shape across providers.
  - Token usage from `usageMetadata.{promptTokenCount, candidatesTokenCount}`, including `cachedContentTokenCount` propagated as `cacheReadInputTokens`.
- **Groq provider client** via `groq-sdk`:
  - Delegates canonical translation to the OpenAI translator (Groq's API surface is OpenAI-compatible).
  - Routes `llama-*`, `mixtral-*`, and `groq/*` model names automatically via `detectProvider()`.
- **`router` module** (3 strategies):
  - `cheapest-first` (default) — sort candidates by per-token price, pick cheapest under `budget_per_request`.
  - `fallback` — pick the first model in the chain.
  - `q-learning` — track per-(query bucket, model) success rates in KV; pick the best for the bucket; cold start falls back to cheapest-first.
- **`prompt-optimizer` module**:
  - Sorts the `tools` array alphabetically for stable cache prefix bytes.
  - In `auto` mode, stamps `cache_control: { type: 'ephemeral' }` on the LAST system block — the Anthropic prefix cache then covers the whole static prefix.
- **`tool-cache` module** (observation-mode v1):
  - POST hook records every `tool_use → tool_result` pair under `(name, sha256(input))` keys with TTL.
  - PRE hook detects when a future request would hit cache and reports it via `tool-cache.would_hit_count`.
  - 13 side-effecting tools (`shell_exec`, `send_email`, `write_file`, etc.) are NEVER cached; user-extendable.
  - **Limitation:** does not yet rewrite requests to inject cached results — that's v1.1 work, blocked on IPC archive integration.
- **`guardrails` module** (regex backend):
  - PII redaction for emails, US SSNs, 16-digit credit cards, North-American phone numbers.
  - Profanity block (small built-in list, extend via `custom_patterns`).
  - User-supplied regex patterns (case-insensitive, invalid patterns silently dropped).
  - `on_pii: 'redact' | 'block' | 'log-only'` — pick your behavior.
- 60+ new tests covering the new providers and modules. Total test count: 116 (up from 60).

### Changed

- Module catalog: 11 modules total (was 7 in v0.1.0).
- `BUILTIN_MODULES` registry expanded with `router`, `prompt-optimizer`, `tool-cache`, `guardrails`.
- `docs/modules.md` rewritten with config + behavior for each new module.
- `.env.example` notes provider key formats and gives a model→provider routing cheat-sheet.

### Roadmap (still v1.1)

- `rehydrator` — pull archived context back into a session on trigger phrases.
- `compaction-bridge` — preserve critical state across Claude Code's auto-compaction.

Both need IPC archive integration that's still in flight; deferring keeps v0.2.0 ship-able.

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
  OpenAI client is a good reference shape. (**Implemented in v0.2.0.**)
