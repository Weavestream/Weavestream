# Developing Weavestream

This guide covers the local workflow for contributors. End-users
deploying with published images want [INSTALL.md](INSTALL.md) instead.

## Prerequisites

- **Node.js 20.11+** (managed with [nvm](https://github.com/nvm-sh/nvm)
  / [fnm](https://github.com/Schniz/fnm) / [Volta](https://volta.sh)).
- **pnpm 9.12+** — install with `corepack enable` then `corepack prepare pnpm@9.12.0 --activate`.
- **Docker Engine 24+** with Compose v2.
- **openssl** (pre-installed on macOS / most Linux distros) or the
  PowerShell keygen for Windows.

## 1. Clone and install

```bash
git clone https://github.com/Weavestream/Weavestream.git
cd Weavestream
pnpm install
```

## 2. Seed your `.env`

```bash
cp .env.example .env
./scripts/keygen.sh >> .env
```

Then edit `.env`:

- Delete the `REPLACEME` rows at the top (keygen output below supersedes).
- Replace the placeholder `REPLACEME` inside `DATABASE_URL` and
  `REDIS_URL` with the real `POSTGRES_PASSWORD` / `REDIS_PASSWORD`
  values you just generated.
- For local `pnpm dev`, point URLs at the host-mapped ports (the
  compose.build.yml override exposes Postgres on `5434`, Redis on
  `6381`, MinIO on `9100/9101`):

  ```env
  DATABASE_URL=postgresql://weavestream:<pw>@localhost:5434/weavestream
  REDIS_URL=redis://:<pw>@localhost:6381/0
  MINIO_ENDPOINT=localhost
  MINIO_PORT=9100
  ```

## 3. Start dependencies

```bash
docker compose -f compose.yml -f compose.build.yml up -d postgres redis minio
pnpm prisma:migrate
```

`compose.build.yml` adds the host port bindings your dev loop needs and
also adds `build:` overrides for the Weavestream services themselves,
so you can iterate on container behavior without waiting for a release.

## 4. Run the dev servers

```bash
pnpm dev
```

This runs `apps/web`, `apps/api`, and `apps/worker` in watch mode in
parallel. The web UI is on <http://localhost:3000>, the API on
<http://localhost:4000>.

## 5. Bootstrap an admin

In a second terminal:

```bash
pnpm --filter @weavestream/api cli create-admin
```

## Common tasks

```bash
pnpm lint               # repo-wide ESLint
pnpm typecheck          # tsc --noEmit everywhere
pnpm test               # Jest (api) + placeholder passes elsewhere
pnpm audit              # prod-only, high-severity

pnpm prisma:migrate     # prisma migrate dev (generates + applies)
pnpm prisma:deploy      # production migrate (what the `migrate` service runs)
pnpm prisma:generate    # regenerate @prisma/client only
```

## Building images locally

```bash
docker compose -f compose.yml -f compose.build.yml build
docker compose -f compose.yml -f compose.build.yml up -d
```

This exercises the exact Dockerfiles that release.yml publishes. Tag
collisions with published images are avoided because the override uses
`image: weavestream-<svc>:dev`.

## Submitting a change

1. Branch off `main`.
2. Make your changes. Add tests when the behavior has a clear contract.
3. Run `pnpm lint && pnpm typecheck && pnpm test`.
4. Add an entry to the `## Unreleased` section of [CHANGELOG.md](../CHANGELOG.md).
5. Open a PR; CI runs the same checks plus `docker-build` for all
   three images.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the licensing note and
review expectations.
