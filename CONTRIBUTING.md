# Contributing to prxy-local

Thank you for considering a contribution.

## Quick start

```bash
git clone https://github.com/Ekkos-Technologies-Inc/prxy-local
cd prxy-local
pnpm install
pnpm dev
```

The local gateway runs on `:3099`.

## Code structure

```
prxy-local/
├── src/
│   ├── server.ts           ← Express entrypoint
│   ├── pipeline/           ← module loader + executor
│   ├── adapters/           ← SQLite + filesystem storage
│   └── providers/          ← Anthropic, OpenAI, Google, Groq clients
├── docker/
│   └── Dockerfile          ← single-image build for distribution
├── tests/
└── docs/
```

## What lives here vs prxy.monster (cloud)

| Lives here (public OSS) | Lives in prxy.monster (private) |
|---|---|
| Local gateway server | Cloud gateway server |
| SQLite storage adapter | Postgres + R2 + Redis adapters |
| All local-compatible modules | Cloud-only modules (sync, collective, dashboard) |
| Module SDK consumption | Billing, auth, dashboard UI |
| Docker image build | Stripe integration |

The shared `@prxy/module-sdk` package is published to npm — both repos consume it. If you write a module here, it works on the cloud version too.

## Pull request guidelines

1. **One change per PR.** Small, focused.
2. **Tests required** for any module change.
3. **Docs updated** when adding features.
4. **No telemetry.** Ever. This repo is privacy-first by design.
5. **No cloud dependencies.** This is the local edition. SQLite, in-memory, filesystem only.

## Module submissions

Want to publish a community module? Don't put it in this repo. Publish it to npm under your own scope, then add it to the [community modules registry](https://github.com/Ekkos-Technologies-Inc/prxy-modules-registry).

## Issues

- Bug reports: include OS, Docker version, what command you ran, expected vs actual
- Feature requests: explain the use case, not just the feature
- Security issues: email security@ekkos.dev — do not file public issues

## License

By contributing, you agree your work is released under the MIT license (same as the project).
