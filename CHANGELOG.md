# Changelog

All notable changes to prxy-local will be documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-04-27

AWS support lands. Fifth provider, alternative blob backend for cloud-hosted
local-mode deploys, and routing precedence updated so Bedrock-hosted models
go to Bedrock no matter which family they belong to.

### Added

- **AWS Bedrock provider client** via `@aws-sdk/client-bedrock-runtime`:
  - Uses the unified Converse API — same request shape for Claude, Llama,
    Titan, Mistral, and Cohere models.
  - Streaming via ConverseStream; tool-use translates to the canonical
    `tool_use`/`tool_result` blocks.
  - Model name format: `bedrock/<model-id>` — e.g.
    `bedrock/anthropic.claude-sonnet-4-20250514-v1:0`,
    `bedrock/meta.llama3-70b-instruct-v1:0`,
    `bedrock/amazon.titan-text-express-v1`.
  - Auth: pass an `AwsCredentials` JSON blob OR a bare region string (the
    SDK then uses its default credential chain — env vars, shared config,
    IAM role, IRSA). The right answer when running on EC2/ECS/App Runner
    is an instance role; no API key to leak.
- **S3 alternative blob backend** (`BlobS3`):
  - Opt-in via `BLOB_BACKEND=s3` (or `LocalAdapterOptions.blobBackend = 's3'`).
  - Stores blobs in an S3 bucket so they survive instance churn — useful
    for "local-mode-on-AWS" deploys (EC2 / ECS / App Runner) where you
    don't want to set up an EFS mount.
  - Filesystem (`fs`) stays the default — a fresh `docker run` doesn't
    require AWS credentials.
- 16 new tests covering Bedrock translation, streaming, credential handling,
  the S3 blob backend, and `detectProvider` precedence for `bedrock/*`.

### Changed

- `Provider` union extended with `'bedrock'`.
- `detectProvider()` checks the `bedrock/` prefix first — the unambiguous
  routing signal — before falling through to the per-family checks.
- `LocalAdapter.blob` is now a `BlobStore` rather than a concrete `LocalBlob`,
  to allow swapping in `BlobS3`. The default behaviour is unchanged.
- `.env.example` documents the Bedrock + `BLOB_BACKEND=s3` knobs.
- `docs/modules.md` adds the provider table.

### Roadmap

CDK self-deploy template lives in the cloud monorepo only — prxy-local users
continue to use `docker run`. If you need a one-command AWS deploy of the
local edition, the cloud `infra/aws-cdk/` template is a 95% drop-in (swap
the gateway image + use `BLOB_BACKEND=s3`).

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
