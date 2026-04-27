# prxy-local

> The open-source local edition of [prxy.monster](https://prxy.monster).
> Run a composable AI gateway on your own hardware. Zero data leaves your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/prxymonster/local)](https://hub.docker.com/r/prxymonster/local)

---

## What this is

A Docker image you run locally to put a smart middleware layer in front of your LLM API calls. Same module system as cloud `prxy.monster`, but everything runs on your machine — SQLite, in-memory cache, local filesystem. Nothing ever phones home.

## Quick start

```bash
docker run -p 3099:3099 -v ~/.prxy:/data \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  prxymonster/local
```

Then in your app:

```bash
export ANTHROPIC_BASE_URL=http://localhost:3099
export ANTHROPIC_API_KEY=sk-ant-xxx   # your real Anthropic key
```

That's it. Your LLM calls now route through prxy-local.

## What you get

- **Infinite context** — messages compressed by age, never deleted
- **MCP optimization** — cuts tool overhead 90%
- **Semantic + exact caching** — repeated queries answered instantly
- **Pattern learning** — Golden Loop, learns from successful conversations
- **Cost guards** — hard budget limits per request/day
- **Multi-provider** — Anthropic, OpenAI, Google, Groq via one key

## Where data lives

```
~/.prxy/
├── prxy.db          ← SQLite (patterns, cache, sessions)
├── evictions/       ← compressed conversation archives
└── config.yaml      ← optional pipeline config
```

Nothing else. No telemetry. No phone-home. Audit the source.

## Privacy modes

Add `airgap` to enforce zero outbound network calls (except to your chosen LLM provider):

```bash
docker run -e PRXY_PIPE=airgap,ipc,patterns,semantic-cache prxymonster/local
```

## When to use cloud vs local

| | Cloud (prxy.monster) | Local (this repo) |
|---|---|---|
| Setup | One env var | One Docker command |
| Memory location | Our infrastructure | Your machine |
| Cross-device sync | Yes | No |
| Collective patterns | Yes | No |
| Air-gap capable | No | Yes |
| Price | Free → $20+/mo | Free, forever |

Same modules. Same pipeline. Different storage backend.

## Documentation

- Full docs: [docs.prxy.monster](https://docs.prxy.monster)
- Local-mode specifics: [docs.prxy.monster/local](https://docs.prxy.monster/local)
- Module catalog: [docs.prxy.monster/modules](https://docs.prxy.monster/modules)

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Relationship to prxy.monster

prxy.monster is the commercial cloud version (closed source). This repo is the open-source local edition that uses the same module system. The `@prxy/module-sdk` package is shared between both (published to npm under MIT license).

If you build a module here, it works on the cloud version too — and vice versa.

## License

MIT — see [LICENSE](LICENSE).
