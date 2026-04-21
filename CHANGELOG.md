# Changelog

All notable changes to Weavestream are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `prisma migrate deploy` now runs inside the `api` container on
  startup instead of as a separate one-shot `migrate` service. Prisma
  takes an advisory lock so concurrent api replicas are still safe.
  This removes the exit-0 `migrate` container that some Docker UIs
  (UGREEN, Portainer, Docker Desktop) were flagging as a project
  error.
- Persistent data now lives in bind-mounted host folders under
  `$DATA_DIR` (defaults to `./data` next to `compose.yml`) instead of
  named Docker volumes. Lets you `ls`, rsync, and back up with
  standard filesystem tools — and lets NAS users point at a specific
  share (e.g. `/volume1/docker/weavestream`) without involving Docker
  volume plumbing.

### Upgrading from 1.0.0

- Re-download `compose.yml` and `.env.example` from the tag you're
  moving to.
- Add `DATA_DIR=...` to your `.env` (or accept the `./data` default).
- **Migrate existing data** from the named volumes to the new folders
  before the first `up`, otherwise the stack will boot against empty
  databases. One-liner per volume:

  ```bash
  # Run AFTER `docker compose down`, BEFORE `docker compose up -d`
  mkdir -p ./data/postgres ./data/redis ./data/minio
  docker run --rm -v weavestream_pg_data:/src -v "$PWD/data/postgres":/dst \
    alpine sh -c 'cp -a /src/. /dst/'
  docker run --rm -v weavestream_redis_data:/src -v "$PWD/data/redis":/dst \
    alpine sh -c 'cp -a /src/. /dst/'
  docker run --rm -v weavestream_minio_data:/src -v "$PWD/data/minio":/dst \
    alpine sh -c 'cp -a /src/. /dst/'
  docker volume rm weavestream_pg_data weavestream_redis_data weavestream_minio_data
  ```

## [1.0.0] - 2026-04-21

Initial public release.

### Highlights

- Postgres-backed, Docker-first IT documentation platform.
- Tenant documentation with Tiptap-based rich-text articles, folders,
  photo galleries, and per-organization asset layouts.
- Invite-only user management with forced TOTP MFA and append-only
  audit logging across every mutation.
- Two-layer RBAC: global roles (`SUPER_ADMIN`, `OPERATOR`, `CONTRACTOR`,
  `CLIENT_USER`) combined with per-tenant memberships, all evaluated
  from a single permission matrix.
- Read-only client portal per tenant, with server-side field scoping
  via the `visibleToClients` flag.
- MinIO-compatible object storage with one bucket per tenant.
- Domain & SSL expiry monitoring.
- Full-text search across articles, assets, and uploads.
- Configurable workspace branding and tenant terminology
  (company / client / department / tenant / site / custom) from the
  admin UI without code changes.
- Mobile-responsive admin shell and client portal.

### Deployment

- Published multi-arch (`linux/amd64`, `linux/arm64`) container images
  at `ghcr.io/weavestream/weavestream-{api,web,worker}:1.0.0`.
- Turnkey `compose.yml` that pulls from GHCR — no source tree or pnpm
  required on the host.
- One-shot `migrate` service runs `prisma migrate deploy` automatically
  on every `docker compose up`.
- OS-native key generation via [`scripts/keygen.sh`](scripts/keygen.sh)
  and [`scripts/keygen.ps1`](scripts/keygen.ps1) — no Docker exec, no
  Node required to seed `.env`.

### Known limitations

- No built-in TLS termination; front with a reverse proxy.
- Single-tenant Postgres (shared schema with `companyId` scoping), not
  database-per-tenant.
- English UI only.

[Unreleased]: https://github.com/Weavestream/Weavestream/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.0.0
