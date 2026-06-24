---
label: Development
icon: code
order: 200
description: Local development setup for contributors working on Weavestream.
---

# Development Setup

This guide covers the local workflow for contributors. It is not the production install path.

End users deploying published images should use the [Quickstart](/getting-started/quickstart/) and [Docker Compose deployment](/deployment/docker-compose/) guides instead.

## Prerequisites

- **Node.js 24+** managed with nvm, fnm, Volta, or a similar version manager.
- **pnpm 11.x** via Corepack. Run `corepack enable` once; later `pnpm` commands use the exact 11.x version declared in `package.json`. Keep that pin current with the latest pnpm 11 release rather than using a floating range.
- **Docker Engine 24+** with Docker Compose v2.
- **openssl** on macOS, Linux, or WSL; Windows users can use the PowerShell keygen script.

## 1. Clone And Install

```bash
git clone https://github.com/Weavestream/Weavestream.git
cd Weavestream
pnpm install
```

## 2. Seed `.env`

```bash
cp .env.example .env
./scripts/keygen.sh >> .env
```

Then edit `.env`:

- Delete the `REPLACEME` rows at the top. The keygen output below supersedes them.
- Replace the placeholder `REPLACEME` inside `DATABASE_URL` and `REDIS_URL` with the generated `POSTGRES_PASSWORD` and `REDIS_PASSWORD` values.
- For local `pnpm dev`, point URLs at the host-mapped ports from `compose.build.yml`:

```env
DATABASE_URL=postgresql://weavestream:<pw>@localhost:5434/weavestream
REDIS_URL=redis://:<pw>@localhost:6381/0
```

The storage defaults `FILE_STORAGE_DIR=./data/files` and `BACKUP_STORAGE_DIR=./data/backup` are anchored to the monorepo root by `resolveDataDir`, even though `pnpm` launches each app from its own package directory. The API and worker therefore share one local storage path without per-developer overrides.

Use absolute paths only if you want development data outside the repository.

## 3. Start Dependencies

```bash
docker compose -f compose.yml -f compose.build.yml up -d postgres redis
pnpm prisma:migrate
```

`compose.build.yml` adds the host port bindings needed for local development and build overrides for the Weavestream services.

## 4. Run The Dev Servers

```bash
pnpm dev
```

This runs `apps/web`, `apps/api`, and `apps/worker` in watch mode.

| Service | Local URL |
|---|---|
| Web UI | `http://localhost:3000` |
| API | `http://localhost:4000` |

## 5. Bootstrap An Admin

In a second terminal:

```bash
pnpm --filter @weavestream/api cli create-admin
```

## Common Tasks

```bash
pnpm lint               # repo-wide ESLint
pnpm typecheck          # tsc --noEmit everywhere
pnpm test               # Jest plus package-level test scripts
pnpm audit              # prod-only, high-severity audit

pnpm prisma:migrate     # prisma migrate dev
pnpm prisma:deploy      # production migrate, same command the api container runs
pnpm prisma:generate    # regenerate @prisma/client
```

## Building Images Locally

```bash
docker compose -f compose.yml -f compose.build.yml build
docker compose -f compose.yml -f compose.build.yml up -d
```

This exercises the same Dockerfiles used by release builds. Tag collisions with published images are avoided because the override uses `image: weavestream-<svc>:dev`.

## Submitting A Change

1. Branch off `main`.
2. Make your changes. Add tests when behaviour has a clear contract.
3. Run `pnpm lint && pnpm typecheck && pnpm test`.
4. Add an entry to the `## Unreleased` section of [CHANGELOG.md](https://github.com/Weavestream/Weavestream/blob/main/CHANGELOG.md).
5. Open a PR. CI runs the same checks plus Docker builds for all three images.

See [CONTRIBUTING.md](https://github.com/Weavestream/Weavestream/blob/main/CONTRIBUTING.md) for licensing notes and review expectations.
