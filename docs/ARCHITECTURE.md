# Architecture

This document describes the big-picture design of Weavestream: what
processes run where, how the tenant model and RBAC layer work, and the
threat model the implementation is written against.

## Topology

```
                               ┌───────────────┐
              browsers ───────▶│  web (Next.js)│──┐
                               └───────────────┘  │   server components
                                                  │   fetch from API
                                                  ▼
┌──────────┐   queues    ┌─────────┐        ┌───────────────┐
│  worker  │◀────────────│  redis  │◀──────▶│  api (Nest)   │
│ (Nest)   │             └─────────┘        └───────────────┘
└────┬─────┘                                       │
     │           ┌──────────┐                      │
     └──────────▶│ postgres │◀─────────────────────┘
                 └──────────┘
                       ▲
                       │
                 ┌─────┴────┐
                 │  minio   │  (per-tenant buckets)
                 └──────────┘
```

- **web** — Next.js 15 App Router. Admin UI + client portals + auth
  flows. Server components proxy through the API internally
  (`API_INTERNAL_URL=http://api:4000`) while browsers talk to the
  public `API_URL`.
- **api** — NestJS. REST + auth + audit + RBAC + uploads + settings.
  Stateless; horizontally scalable.
- **worker** — NestJS BullMQ consumer. No HTTP listener. Runs the same
  domain services as the API for search indexing, domain/SSL polling,
  thumbnail generation, etc.
- **Schema migrations** — `api` runs `prisma migrate deploy` on every
  startup before binding its HTTP listener. `prisma migrate deploy` is
  idempotent and guarded by a Postgres advisory lock, so it's safe to
  run on every boot and on every node when scaling horizontally.

## Tenant & terminology model

Weavestream ships with a singleton `system_settings` row that drives
the workspace chip and the word we use for "tenant" everywhere in the
UI. `SUPER_ADMIN` can change these at **Admin → Settings** at any time;
URL routes, API paths, Prisma columns, and RBAC keys all continue to
read `company` / `companies` under the hood — the terminology changes
are purely cosmetic.

| Setting                  | Shown in                                               | Default       |
| ------------------------ | ------------------------------------------------------ | ------------- |
| Workspace name           | Sidebar chip (top-left of every admin page)            | `My Company`  |
| Workspace subtitle       | Small muted text under the workspace name              | `workspace`   |
| Tenant term (singular)   | Buttons, dialog titles, help text, empty states        | `Company`     |
| Tenant term (plural)     | Sidebar nav, breadcrumbs, column headers, page titles  | `Companies`   |
| Tenant term (possessive) | Phrases like "this client's assets" (auto if blank)    | `Company's`   |

Presets for common alternatives — `Client`, `Department`, `Tenant`,
`Organization`, `Site` — plus a **Custom…** option for bespoke
vocabulary. A live preview renders the sidebar nav, dialog titles, and
empty-state copy side-by-side as you type.

## RBAC

Two layers, evaluated together from a single permission matrix.

**Global roles** (column on `users`):

- `SUPER_ADMIN` — can do anything in any tenant; manages system settings.
- `OPERATOR` — can be granted `OPERATOR_FULL` or `OPERATOR_READONLY`
  on specific tenants.
- `CONTRACTOR` — same shape as OPERATOR but memberships carry an
  `expiresAt`; access is rejected on the next request past expiry.
- `CLIENT_USER` — limited to tenants where they hold a client membership.

**Per-tenant memberships**: `OPERATOR_FULL`, `OPERATOR_READONLY`,
`CLIENT_ADMIN`, `CLIENT_VIEWER`.

All authorization checks go through the matrix — there are no ad-hoc
role comparisons in controllers.

## Threat model

- **External attacker (unauthenticated)** — blocked by per-IP and
  per-email login lockout, global rate limiting, strict CSP,
  `sameSite=lax` session cookies, and required MFA on every account.
  Generic 401 responses avoid user/asset enumeration.
- **Client portal user** — can only see their own tenant's data. No
  admin routes. Fields marked `visibleToClients=false` are stripped
  server-side before response.
- **Fill-in operator (contractor)** — membership carries `expiresAt`;
  requests past expiry are rejected. No user management.
- **Compromised operator account** — append-only audit log; session
  revocation is immediate (no offline tokens); JWTs are 15 min and
  backed by a server-side session row that can be revoked.
- **Insider (operator)** — audit log is append-only at the DB-role
  level. Even the operator cannot rewrite history without Postgres
  superuser access.

## Data layout

One Postgres database. Tenants share tables but scope via foreign key
(`companyId`) and RLS-equivalent checks in application code.

Object storage uses **one MinIO bucket per tenant** (`<prefix>-<tenantId>`),
so even an IDOR in application code cannot cross tenants at the storage
layer. Presigned URLs are scoped to the tenant's bucket.

## Repo layout

```
apps/
  api/       NestJS — REST API, auth, audit, RBAC, uploads, settings
  web/       Next.js 15 App Router — admin, portals, auth flows
  worker/    NestJS BullMQ consumer — indexing, monitoring, thumbnails
packages/
  db/        Prisma schema + migrations + client export
  shared/    Zod env schema, role types, Tiptap helpers, DTO schemas
  config/    Shared tsconfig bases
docker/      Per-app Dockerfiles
scripts/     keygen.{sh,ps1}, misc dev tools
compose.yml           end-user compose (pulls images)
compose.build.yml     contributor overrides (build locally, expose host ports)
```

## Further reading

- [INSTALL.md](INSTALL.md) — deployment walkthrough
- [CONFIGURATION.md](CONFIGURATION.md) — every environment variable
- [DEVELOPING.md](DEVELOPING.md) — contributor quickstart
- [RELEASING.md](RELEASING.md) — how a version gets cut
