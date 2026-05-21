---
label: Overview
icon: info
order: 900
description: Technical orientation for Weavestream's modules, deployment model, and core documentation.
---

# What is Weavestream?

Weavestream is a **self-hosted IT documentation platform** for structured infrastructure records: tenants, assets, credentials, articles, domains, files, IP ranges, users, integrations, and audit history.

This section gives a high-level orientation before you move into installation, configuration, and feature-specific docs.

## Platform model

Weavestream is organised around a few core ideas:

- **Workspace** — the single Weavestream deployment, including global settings and terminology.
- **Tenant** — the top-level container for customer, department, site, or environment data.
- **Structured records** — assets, passwords, articles, domains, uploads, IP ranges, and related entities.
- **Relationships** — links between records so assets, credentials, procedures, domains, and files can be followed in context.
- **Memberships and capabilities** — role-based access at both platform and tenant scope.
- **Audit history** — append-only mutation records for operational visibility and accountability.

See [Key Concepts](/overview/concepts/) for the full terminology reference.

## What it includes

| Feature | Description |
|---|---|
| [Asset management](/features/assets/) | Customisable layouts with 14+ field types for structured infrastructure records |
| [Password vault](/features/passwords/) | AES-256-GCM encrypted credentials with TOTP, breach checking, and version history |
| [Documentation](/features/articles/) | Rich-text or Markdown articles organised into folders per tenant |
| [Domain monitoring](/features/domains/) | WHOIS, DNS, and TLS/SSL expiry tracking |
| [File uploads](/features/files/) | Per-tenant object storage with photo galleries |
| [IP address management](/features/ipam/) | IPv4 subnet tracking with occupancy detection, reservations, and conflict visibility |
| [Client portal](/features/client-portal/) | Read-only portal scoped to tenant data explicitly exposed to client users |
| [User management](/features/users/) | Role, membership, default access, capabilities, invite-only onboarding, and forced MFA |
| [Audit log](/features/audit/) | Append-only, tamper-resistant mutation history |
| [Full-text search](/features/search/) | PostgreSQL-backed search across articles, assets, and uploads |
| [Integrations](/features/integrations/) | External system sync into tenant asset records |

## Deployment model

Weavestream runs as five Docker containers orchestrated by Docker Compose:

| Service | Role |
|---|---|
| `web` | Next.js frontend for the admin UI, client portals, and auth flows |
| `api` | NestJS REST API for auth, RBAC, audit, uploads, settings, and business logic |
| `worker` | Background jobs for domain checks, thumbnails, search indexing, alerts, and integrations |
| `postgres` | Primary relational database |
| `redis` | Session store, queues, rate-limit buckets, and cache |

Persistent data lives under `$DATA_DIR`: Postgres data, Redis data, uploaded files, and scheduled backup dumps. Uploaded files are stored on the host filesystem and streamed through the API; the file directory is not exposed directly by the web server.

See [Architecture](/overview/architecture/) for topology, request flow, RBAC resolution, data layout, and scaling notes.

## Operating assumptions

- **Docker-first deployment.** Published images are pulled from GHCR; no source checkout or host-side build step is required.
- **Operator-controlled storage.** Backups are standard Postgres dumps plus filesystem copies of uploaded files and `.env` secrets.
- **Forced MFA.** Every account enrolls TOTP before using the application.
- **Server-side authorization.** Tenant scoping, client visibility, and capabilities are enforced by the API.
- **Append-only audit logging.** Mutations and sensitive access events are captured for review.
- **Configurable terminology.** The UI label for tenants can be changed without changing routes, API paths, or database columns.

## Next steps

- [Key concepts](/overview/concepts/) — understand the core data model and terminology
- [Architecture](/overview/architecture/) — review containers, request flow, RBAC, and data layout
- [Getting started](/getting-started/) — deploy Weavestream with Docker Compose
- [Feature reference](/features/) — browse module-level documentation
