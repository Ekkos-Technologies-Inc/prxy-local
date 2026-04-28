# airgap — privacy guarantees

`airgap` is the local edition's hard-line privacy module. When it's in the
pipeline, the gateway monkey-patches `globalThis.fetch` once at boot and
rejects any outbound request whose host isn't on the allowed list.

## What it blocks

- All `fetch()` calls from any module — embeddings, telemetry, anything.
- All `fetch()` calls from your code if you mount custom routes that share
  the process.
- Indirectly: anything in node_modules that uses `fetch` under the hood.

## What it allows

By default, the four provider API hosts:
- `api.anthropic.com`
- `api.openai.com`
- `generativelanguage.googleapis.com`
- `api.groq.com`

Suffix matches count: `anthropic.com` allows `api.anthropic.com` AND
`some-shard.api.anthropic.com`.

## Configure

```yaml
- module: airgap
  config:
    allowedHosts:
      - api.anthropic.com           # only Claude
    denyAll: false
```

```yaml
- module: airgap
  config:
    denyAll: true                   # block EVERYTHING, even providers.
                                    # Useful for tests + offline replays.
```

## How embeddings behave

`semantic-cache`, `patterns`, and `mcp-optimizer` all need embeddings.
By default they call Voyage AI or OpenAI. With `airgap` in the pipeline:

1. The embed call attempts the configured provider.
2. The airgap guard rejects it (Voyage is not on the default allow list).
3. The embed abstraction catches the error and falls back to the
   deterministic **stub embed** — a hash-based bag-of-trigrams projected to
   256 floats then L2-normalized.

The stub embed is much weaker than a real model, but it's stable and
offline-safe. Cache hit rates drop, but the system stays functional.

If you want embeddings AND airgap, add your embedding host to the allow list:

```yaml
- module: airgap
  config:
    allowedHosts:
      - api.anthropic.com
      - api.voyageai.com
```

## What's NOT blocked

- The KV store (in-memory, in-process)
- The SQLite database (local file)
- The blob store (local filesystem)
- stdout / stderr / file logs

The guard only intercepts `globalThis.fetch`. If a module uses `node:http` or
`node:https` directly (no current built-in does), airgap will not see those
calls. PRs welcome to extend the guard.

## Verify

```bash
LOCAL_MODE=true PRXY_PIPE=airgap node dist/server.js
```

Then issue a request that would normally hit a non-allowed host. You'll see
the airgap rejection in the gateway logs:

```
airgap: outbound network blocked. Host 'example.com' is not in the allowed list.
```

The `airgap` module's `pre()` hook also stamps the request metadata with
`airgap.installed=true` and the active allowed list, so downstream modules
or your own logging can confirm the guard is in place.
