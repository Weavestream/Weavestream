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
            (api & worker also share)
                       │
                 ┌─────┴────────────┐
                 │  files (bind     │
                 │  mount, per      │
                 │  tenant subdir)  │
                 └──────────────────┘
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

Three orthogonal axes, evaluated by a single resolver
(`apps/api/src/rbac/permission.service.ts`). The web layer mirrors the
same logic in `apps/web/src/lib/roles.ts` purely to hide unreachable
controls — every check is re-validated server-side.

**Global roles** (column on `users`):

- `SUPER_ADMIN` — owner-level. Implicit FULL access to every tenant
  *and* implicit holder of every `PlatformCapability`. Cannot be
  demoted via the UI; the system requires at least one super admin.
- `OPERATOR` — staff role. Per-tenant access is configurable on three
  axes (see below). Can be promoted to "senior operator" by granting
  individual capabilities without handing out super admin.
- `CONTRACTOR` — short-term staff. Always per-tenant only; every
  membership requires `expiresAt`. Never holds capabilities or
  `globalAccess`. Reads only the tenants they are explicitly attached
  to, and access flips off the next request past expiry.
- `CLIENT_USER` — tenant end-user. Membership is always `READONLY`;
  the API rejects writes regardless of UI state.

**Membership role** (`memberships.role`): `FULL` or `READONLY`. A
membership row is the per-tenant override.

**Default access** (`users.globalAccess`, only meaningful for
`OPERATOR`): `FULL`, `READONLY`, or `NONE`. Applied to every tenant
the operator does *not* have an explicit membership for. `NONE` makes
the operator membership-only — useful for technicians who should only
see their assigned tenants.

**Platform capabilities** (`users.platformCapabilities`, array): a
fine-grained list of platform-admin tasks delegated to operators
(`COMPANY_MANAGE`, `INTEGRATION_MANAGE`, `LAYOUT_MANAGE`,
`USER_MANAGE`, `MEMBERSHIP_MANAGE`, `AUDIT_READ`, `SETTINGS_MANAGE`,
`EXPORT_CREATE`, `ALERT_MANAGE`, `TAG_MANAGE`, `SECURITY_READ`).
`SUPER_ADMIN` holds them implicitly; the API rejects setting them on
any other role.

**Resolution order** for "can the viewer do X on tenant T?":

1. `SUPER_ADMIN` ⇒ yes.
2. If the operation declares a `requiredCapability`, the viewer must
   hold it on `users.platformCapabilities` (or be `SUPER_ADMIN`). No
   capability ⇒ no.
3. Active `Membership` for tenant T overrides everything else: `FULL`
   permits writes, `READONLY` permits reads only.
4. Otherwise fall back to `users.globalAccess` for `OPERATOR`s
   (`FULL`/`READONLY`); `NONE` is a hard deny.

All authorization checks flow through the resolver — there are no ad-hoc
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
  requests past expiry are rejected. Never holds platform capabilities
  or `globalAccess`, so cross-tenant reads and admin-shell access are
  unreachable by construction.
- **Compromised operator account** — append-only audit log; session
  revocation is immediate (no offline tokens); JWTs are 15 min and
  backed by a server-side session row that can be revoked.
- **Insider (operator)** — audit log is append-only at the DB-role
  level. Even the operator cannot rewrite history without Postgres
  superuser access.

## Data layout

One Postgres database. Tenants share tables but scope via foreign key
(`companyId`) and RLS-equivalent checks in application code.

File storage uses **one directory per tenant** under
`${FILE_STORAGE_DIR}/<tenantId>/`. The api and worker mount the same
host directory and write atomically (`<key>.tmp-<rand>` then
`fs.rename`). Browsers never read the directory directly — every
access goes through the API's streaming endpoints, which authorize
the request against the requested tenant before opening the file.

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
