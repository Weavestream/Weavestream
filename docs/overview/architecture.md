---
label: Architecture
icon: workflow
order: 700
description: How Weavestream's processes, data, and security model fit together.
---

# Architecture

## Topology

Weavestream runs as five Docker containers orchestrated by a single `compose.yml`:

```
                           ┌───────────────┐
          browsers ───────▶│  web (Next.js)│──┐
                           └───────────────┘  │  server components
                                              │  fetch from API
                                              ▼
┌──────────┐   queues    ┌─────────┐    ┌───────────────┐
│  worker  │◀────────────│  redis  │◀──▶│  api (Nest)   │
│ (Nest)   │             └─────────┘    └───────────────┘
└────┬─────┘                                   │
     │         ┌──────────┐                    │
     └────────▶│ postgres │◀───────────────────┘
               └──────────┘
                     ▲
                     │
        (api & worker also share)
                     │
              ┌──────┴────────────┐
              │  files (host bind │
              │  mount, per-tenant│
              │  subdirectory)    │
              └───────────────────┘
```

### Services

| Service | Image | Role |
|---|---|---|
| `web` | `ghcr.io/weavestream/weavestream-web` | Next.js 15 App Router — admin UI, client portals, auth flows |
| `api` | `ghcr.io/weavestream/weavestream-api` | NestJS REST API — auth, RBAC, audit, uploads, settings |
| `worker` | `ghcr.io/weavestream/weavestream-worker` | NestJS BullMQ consumer — domain checks, thumbnails, search indexing, alerts, integrations |
| `postgres` | `postgres:16` | Primary relational database |
| `redis` | `redis:7` | Session store, rate-limit buckets, BullMQ queues, cache |

Uploaded files (attachments, thumbnails, logos, export PDFs) live on a host bind-mounted directory (`${DATA_DIR}/files`) shared by `api` and `worker`. Tenant isolation is by directory.

### Request flow

1. **Browser** → `web` (port 3000). Server components call `api` via the internal Docker network (`API_INTERNAL_URL`, normally `http://api:4000`). Client-side components call `api` via the public `API_URL`.
2. **`api`** validates the session JWT, checks RBAC, runs the business logic, and writes to Postgres.
3. **Background work** (domain polling, thumbnail generation, search indexing) is enqueued via Redis/BullMQ and consumed by `worker`.
4. **File uploads** go browser → `api` (auth + validation + metadata) → local filesystem storage. Downloads stream back through the API on the same origin so the storage directory has no public surface.

The `worker` runs the same domain services as the API where background jobs need business logic, but it has no HTTP listener. It only consumes queues and scheduled jobs.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tiptap 3, Tailwind CSS, shadcn/ui |
| Backend | NestJS 11, Prisma 5, Node.js |
| Database | PostgreSQL 16+ (JSONB, tsvector, GIN indexes, advisory locks) |
| Cache & queues | Redis 7+, BullMQ |
| File storage | Local filesystem, host-bind-mounted, per-tenant subdirectory |
| Auth | Argon2 (password hashing), JOSE (JWT), otplib (TOTP), zxcvbn-ts |
| Image processing | Sharp (libvips) — thumbnails and dimension metadata |
| Search | PostgreSQL tsvector (full-text) via denormalised `SearchIndex` table |

## Tenant model

### Shared schema, isolated storage

All tenants share a single Postgres database and schema. Tenant data is scoped in application code via a `companyId` foreign key and validated on every request. There is no database-per-tenant.

File storage uses **one directory per tenant** under `${FILE_STORAGE_DIR}/<tenantId>/`. The storage layer rejects keys containing `..`, leading slashes, or null bytes and re-asserts that every resolved path stays inside the tenant directory before opening a file — defense in depth against any future IDOR in application code.

The `api` and `worker` containers mount the same host directory. File writes are atomic: data is written to a temporary sibling path first, then moved into place with `rename`. Browsers never read from the storage directory directly; every download or image request streams through the API after tenant authorization.

### Configurable terminology

The word used for "tenant" everywhere in the UI is set by `SUPER_ADMIN` at **Admin → Settings**. Presets: Company, Client, Department, Tenant, Organisation, Site, or Custom. URL routes, API paths, and Prisma columns always use `company` / `companies` internally — the terminology change is cosmetic only.

The workspace name, subtitle, tenant terminology, and related UI settings are stored in a singleton `system_settings` row. See [Workspace Settings](/configuration/workspace-settings/) for the operator-facing controls.

## RBAC

Three orthogonal axes are evaluated by a single resolver:

**Global roles** (stored on the `users` table):

| Role | Description |
|---|---|
| `SUPER_ADMIN` | Implicit full access to every tenant and every platform capability |
| `OPERATOR` | Staff role with configurable default tenant access and optional platform capabilities |
| `CONTRACTOR` | Per-tenant only, memberships require `expiresAt`, no `globalAccess` or capabilities |
| `CLIENT_USER` | Tenant end-user, always read-only regardless of UI state |

**Membership role** (`memberships.role`):

| Value | Access |
|---|---|
| `FULL` | Read/write within that tenant |
| `READONLY` | Read-only within that tenant |

**Default tenant access** (`users.globalAccess`, `OPERATOR` only):

| Value | Meaning |
|---|---|
| `FULL` | Read/write on tenants without explicit membership overrides |
| `READONLY` | Read-only on tenants without explicit membership overrides |
| `NONE` | Membership-only access (hard deny otherwise) |

**Platform capabilities** (`users.platformCapabilities`):
`COMPANY_MANAGE`, `INTEGRATION_MANAGE`, `LAYOUT_MANAGE`, `TAG_MANAGE`, `USER_MANAGE`, `MEMBERSHIP_MANAGE`, `AUDIT_READ`, `SETTINGS_MANAGE`, `EXPORT_CREATE`, `ALERT_MANAGE`, `SECURITY_READ`, `IP_RULE_MANAGE`, `BACKUP_MANAGE`

`SUPER_ADMIN` holds all capabilities implicitly; the API rejects capabilities on unsupported roles.

Resolution order for tenant checks:
1. `SUPER_ADMIN` => allow.
2. If the action requires a capability, require it (or `SUPER_ADMIN`) or deny.
3. Active tenant membership overrides everything else (`FULL`/`READONLY`).
4. Otherwise fall back to `users.globalAccess` for `OPERATOR` (`FULL`/`READONLY`/`NONE`).

All authorization checks go through the resolver. There are no ad-hoc role comparisons in controllers.

## Schema migrations

`api` runs `prisma migrate deploy` on every startup, before binding its HTTP listener. The command is idempotent and guarded by a Postgres advisory lock — safe to run on boot and safe when scaling horizontally.

## Data layout

Persistent data lives in host-mounted folders under `$DATA_DIR` (default `./data` next to `compose.yml`):

| Folder | Contents | Back up? |
|---|---|---|
| `$DATA_DIR/postgres` | Postgres data directory | **Yes** |
| `$DATA_DIR/files` | Uploaded files (attachments, thumbnails, logos, exports) | **Yes** |
| `$DATA_DIR/redis` | Cache + BullMQ queues (replayable) | Optional |

## Source layout

The public repository is organised around deployable apps and shared packages:

```text
apps/
  api/       NestJS REST API: auth, audit, RBAC, uploads, settings
  web/       Next.js 15 App Router: admin UI, portals, auth flows
  worker/    NestJS BullMQ consumer: indexing, monitoring, thumbnails
packages/
  db/        Prisma schema, migrations, and client export
  shared/    Zod env schema, role types, Tiptap helpers, DTO schemas
  config/    Shared TypeScript configuration
docker/      Per-app Dockerfiles
scripts/     keygen.sh, keygen.ps1, and other project scripts
compose.yml           End-user compose file that pulls published images
compose.build.yml     Contributor compose overrides for local builds
```

## Scalability notes

- `api` is **stateless** and horizontally scalable. Session state is in Redis; Postgres advisory locks prevent migration races.
- `worker` can run multiple replicas; BullMQ distributes jobs across consumers.
- `web` (Next.js) is stateless and can be replicated behind a load balancer.
- Single-tenant Postgres is the primary bottleneck for very large deployments. Multi-database support is not currently planned.
