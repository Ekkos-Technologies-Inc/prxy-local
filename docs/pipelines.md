# Pipeline recipes

The pipeline is a comma-separated list of module names (or a YAML list with
parameters). Modules run in declared order. Each module's `pre()` can
short-circuit the pipeline before the provider is called.

## Recipes

### Default — fast cache + smart context

```
PRXY_PIPE=mcp-optimizer,semantic-cache,patterns
```

Best general-purpose pipeline. Embeds + prunes MCP tools, then checks the
semantic cache, then injects relevant past patterns into the system prompt.

### Privacy mode — never phone home

```
PRXY_PIPE=airgap,ipc,patterns,semantic-cache
```

`airgap` blocks every outbound call except to your configured provider host.
`ipc` keeps the request small. `patterns` and `semantic-cache` give you the
learning + cache-hit benefits without any external calls beyond the LLM
itself. Embeddings fall back to the offline stub embed.

### Cost-first — hard budget caps

```yaml
- module: cost-guard
  config:
    perRequest: 0.10
    perDay: 5.00
    perMonth: 50.00
- exact-cache
- mcp-optimizer
- patterns
```

Block any single request that would cost more than 10¢. Cap daily spend at
$5, monthly at $50. Cache identical requests so repeats are free.

### Long-context — keep conversations going forever

```yaml
- ipc
- semantic-cache
- patterns
- module: ipc
  config:
    targetUtilization: 0.5
    keepRecent: 10
```

Aggressive compression: kick in at 50% context, keep the last 10 turns
verbatim. Older turns get extractive-summary'd into a single `<earlier-
conversation-summary>` block.

### Tools-heavy — surgical MCP optimization

```yaml
- module: mcp-optimizer
  config:
    relevanceThreshold: 0.75
    minToolsToOptimize: 10
    preserveTools:
      - get_current_time
      - search_web
- semantic-cache
- patterns
```

Higher threshold = aggressive pruning. Always keep the always-needed tools
via `preserveTools`.

## Per-key vs per-request

- **Per-key (`apiKey.pipelineConfig`)** — fixed per API key. Useful for
  templating different agents that share a gateway.
- **Per-request (`x-prxy-pipe` header)** — overrides everything for a single
  call. Useful for one-off "give me the cheapest pipeline for this batch".
- **Env (`PRXY_PIPE`)** — process-wide default.
- **File (`PRXY_PIPE_FILE`)** — YAML pipeline file. Useful for parameterized
  configs you don't want to inline in env vars.
