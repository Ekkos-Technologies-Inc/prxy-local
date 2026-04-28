# Modules

prxy-local ships seven built-in modules. They're composable middleware around
the LLM provider call: `pre()` runs before, can short-circuit the pipeline
(cache hit, budget block); `post()` runs after, fire-and-forget (cache write,
pattern forge, telemetry).

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

## What's NOT here

- **`usage-tracker`** — cloud-only. It reports each request to the prxy.monster
  billing engine. Local users get the same per-day / per-month caps from
  `cost-guard` without phoning home.
- **Stripe / billing modules** — there's no payment surface in local mode.
- **Sync / collective patterns** — the cloud edition syncs patterns across
  devices and surfaces collective patterns from other users. Local is a
  single-machine memory.
