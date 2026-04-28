# Modules

prxy-local v0.2.0 ships **eleven built-in modules**. They're composable
middleware around the LLM provider call: `pre()` runs before, can short-circuit
the pipeline (cache hit, budget block); `post()` runs after, fire-and-forget
(cache write, pattern forge, telemetry).

Set the active pipeline with the `PRXY_PIPE` env var (comma-separated module
names, in order) or per-request with the `x-prxy-pipe` header.

## Catalog

| Name | Phase | What it does |
|------|-------|--------------|
| `airgap` | pre + init | Blocks all outbound network calls except to a whitelist of provider hosts. |
| `mcp-optimizer` | pre | Embeds MCP tools + the user's last message, prunes tools below a relevance threshold. |
| `exact-cache` | pre + post | sha256 of the canonical request → response cache hit. |
| `semantic-cache` | pre + post | Vector-similarity cache hit on the message stream. |
| `patterns` | pre + post | Golden Loop. Injects relevant past patterns into the system prompt; forges new ones from `the issue was X / fix is Y` markers in responses. |
| `cost-guard` | pre + post | Per-request, per-day, per-month USD spend caps. |
| `ipc` | pre | Inter-Prompt Compression — summarizes older messages once the request crosses a context-utilization threshold. |
| `router` | pre + post | Smart model selection. Three strategies: `cheapest-first` (default), `fallback`, `q-learning` (learns from outcomes). |
| `prompt-optimizer` | pre | Restructures the request to maximize Anthropic prefix-cache hits. Sorts tools, stamps `cache_control` on the static prefix. |
| `tool-cache` | pre + post | Observes MCP `tool_use → tool_result` pairs, records them, detects would-be cache hits. v1 = observation; v1.1 = injection. |
| `guardrails` | pre | Regex content filtering: PII redaction (email/SSN/card/phone), profanity blocks, custom patterns. |

The default pipeline (when nothing else is configured) is:

```
mcp-optimizer,semantic-cache,patterns
```

## Per-module config

Use the YAML form to parameterize a module:

```yaml
- module: cost-guard
  config:
    perRequest: 0.50
    perDay: 5.00
- module: airgap
  config:
    allowedHosts:
      - api.anthropic.com
- semantic-cache
- patterns
```

Save as `pipeline.yaml`, point `PRXY_PIPE_FILE` at it, restart.

## airgap (local-only)

The local edition's privacy guarantee. Once installed, `globalThis.fetch` is
monkey-patched to throw on any URL whose host isn't in the allowed list.

```yaml
- module: airgap
  config:
    allowedHosts:
      - api.anthropic.com
      - api.openai.com
      - generativelanguage.googleapis.com
      - api.groq.com
    denyAll: false   # set true to block providers too
```

If embeddings (Voyage, OpenAI) are blocked by the airgap, the embedding
abstraction falls back to the deterministic stub embed. Semantic-cache and
patterns still work — recall quality drops but the system stays online.

See [airgap.md](./airgap.md) for the privacy model in detail.

## router

Smart model selection. Three strategies, swappable at any time:

```yaml
- module: router
  config:
    strategy: 'cheapest-first'   # 'q-learning' | 'fallback' | 'cheapest-first'
    fallback_chain:
      - claude-sonnet-4
      - gpt-4o-mini
      - gemini-2.0-flash
    prefer:
      - claude-haiku-4
    budget_per_request: 0.10     # never pick a model whose estimate exceeds this
```

- **`cheapest-first`** sorts the candidate list by per-token price and picks the cheapest under budget.
- **`fallback`** picks `fallback_chain[0]`. (Real fallback-on-error happens at the gateway pipeline level.)
- **`q-learning`** keeps a per-(query bucket, model) success-rate table in KV. Picks the highest-rated model for the bucket. Cold start falls back to cheapest-first. The post hook updates the table with the response outcome.

Records `router.requested_model` and `router.selected_model` in metadata so observability can see what changed.

## prompt-optimizer

Maximizes Anthropic prefix-cache hits.

```yaml
- module: prompt-optimizer
  config:
    cacheControl: 'auto'         # 'auto' | 'manual' | 'off'
    separateStatic: true         # sort tools alphabetically
    minCacheableChars: 1024
    markAssistantHistory: false  # also mark last assistant turn
```

In auto mode the module:

1. Sorts your `tools` array by name (deterministic prefix bytes).
2. Stamps `cache_control: { type: 'ephemeral' }` on the **last** system block. Anthropic caches everything UP TO and INCLUDING a marker, so the tail of the static prefix gives the maximal cacheable region.

For non-Anthropic providers this is a no-op.

## tool-cache (observation mode in v1)

Solves the "agent reads the same file 14 times in one session" problem — one
step at a time.

```yaml
- module: tool-cache
  config:
    ttlSeconds: 60
    excludeTools: ['my_dangerous_tool']
    perToolTtl:
      read_file: 30
      git_log: 300
```

**v1 limitation:** the module observes and records tool calls + results, and
detects when a future request would hit cache (visible via metadata). It does
NOT yet rewrite requests to inject cached results in place of `tool_use`
blocks — that needs deeper IPC work. v1.1 will flip that switch.

Side-effecting tools are NEVER recorded by default: `bash`, `shell_exec`,
`shell`, `send_email`, `write_file`, `edit_file`, `create_file`, `delete_file`,
`commit`, `push`, `deploy`, `execute_sql`, `http_request`. You can extend this
list via `excludeTools` but cannot remove from it.

## guardrails

Content filtering at the gateway layer.

```yaml
- module: guardrails
  config:
    pii_redact: true
    profanity_block: false
    custom_patterns:
      - 'sk-[a-zA-Z0-9]{20,}'   # block accidental API key paste
    backend: 'regex'             # only 'regex' in v1
    on_pii: 'redact'             # 'redact' | 'block' | 'log-only'
```

Built-in PII patterns:

- **Email** → `[REDACTED_EMAIL]`
- **US SSN** (`123-45-6789`) → `[REDACTED_SSN]`
- **16-digit credit card** → `[REDACTED_CARD]`
- **North-American phone** → `[REDACTED_PHONE]`

Custom patterns are compiled with the case-insensitive flag. Invalid regex
strings are silently dropped (won't crash the module).

v1.1 will add a `'callout'` backend for NIM / Anthropic Constitutional / OpenAI
Moderation.

## What's NOT here

- **`usage-tracker`** — cloud-only. It reports each request to the prxy.monster
  billing engine. Local users get the same per-day / per-month caps from
  `cost-guard` without phoning home.
- **Stripe / billing modules** — there's no payment surface in local mode.
- **Sync / collective patterns** — the cloud edition syncs patterns across
  devices and surfaces collective patterns from other users. Local is a
  single-machine memory.
