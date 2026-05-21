<div align="center">

<img src="apps/web/public/brand/logo-mark.svg" alt="Weavestream" height="72" />

</div>

# Weavestream

**A self-hosted documentation platform with a clean UI and Docker-first deployment.**
_Your knowledge base, your infrastructure._

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![CI](https://github.com/Weavestream/Weavestream/actions/workflows/ci.yml/badge.svg)](https://github.com/Weavestream/Weavestream/actions/workflows/ci.yml)
[![Release](https://github.com/Weavestream/Weavestream/actions/workflows/release.yml/badge.svg)](https://github.com/Weavestream/Weavestream/actions/workflows/release.yml)
[![Website](https://img.shields.io/badge/Website-weavestream.io-blue)](https://weavestream.io)



---

→ **Full feature docs and guides at [weavestream.io](https://weavestream.io)**

Weavestream is a Postgres-backed IT documentation platform designed for
small teams, MSPs, and homelabs. One codebase, one distribution — the
operator chooses what to call their tenants (companies, clients,
departments, sites, …) from the admin UI, so the same build fits every
audience without code changes.

![Weavestream Tenant Dashboard](./weavestream-company-dashboard.png)

## Highlights

- **Tenant documentation.** Markdown and rich-text articles, folders, photo
  galleries, and configurable asset layouts per organization.
- **Password management.** AES-256-GCM encrypted credential storage with
  TOTP support, breach detection, and role-based access control.
- **IP Address Management (IPAM).** Manage IPv4 subnets, track utilization,
  detect conflicts with asset IP fields, and expose network data to clients.
- **Domain & SSL monitoring.** WHOIS expiry, DNS health, and TLS certificate
  validity checks with aggregated expiration dashboards.
- **Expiration tracking.** Monitor asset expiration dates (licenses,
  warranties, SSL certificates, passwords) with visibility into upcoming renewals.
- **AI Chat.** Ask questions, draft documentation, and edit articles directly from a persistent chat panel. Powered by any OpenAI-compatible LLM you configure.
- **Alert system.** Email notifications for expirations, website downtime,
  and record lifecycle events with flexible scheduling.
- **Security Center.** Admin dashboard for login activity, active sessions,
  lockouts, rate-limit blocks, and egress attempt monitoring.
- **Integrations.** Sync inventory from external platforms (Action1, UniFi)
  into tenant asset records on demand or on a schedule.
- **Invite-only user management** with per-user setup tokens, forced
  TOTP MFA, IP-based access rules, and append-only audit logging.
- **Two-layer RBAC.** Global roles combined with per-tenant memberships
  evaluated from a single permission matrix.
- **Client portals.** Each tenant gets a read-only portal where client
  users see only the articles, assets, passwords, and domains their role allows.
- **Local file storage.** Tenant files live on a shared host-mounted
  filesystem path with per-tenant directory isolation.
- **Docker-first.** Three containers (`api`, `web`, `worker`) plus
  Postgres and Redis. Pulled, not built.

See the [architecture docs](https://docs.weavestream.io/overview/architecture/) for the topology,
RBAC model, storage layout, terminology system, and repo layout.

## Quickstart

```bash
# Grab the compose file and env template
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/compose.yml
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/.env.example
mv .env.example .env

# Generate random keys (macOS/Linux/WSL)
curl https://raw.githubusercontent.com/Weavestream/Weavestream/main/scripts/keygen.sh | bash >> .env

# Start everything
docker compose up -d

# Create the first admin
docker compose exec api node dist/cli.js create-admin
```

Open <http://localhost:3000/login> and sign in. On Windows, use
[`scripts/keygen.ps1`](scripts/keygen.ps1) instead.

Full walkthrough — pinning a version, upgrades, reverse-proxy/TLS,
backups — in the [Docker install docs](https://docs.weavestream.io/getting-started/quickstart/).

Full guided walkthrough on the docs site: [docs.weavestream.io/getting-started](https://docs.weavestream.io/getting-started/)

## Documentation

| Guide                                         | Audience          |
| --------------------------------------------- | ----------------- |
| [Docker install docs](https://docs.weavestream.io/getting-started/quickstart/) | Operators         |
| [Configuration docs](https://docs.weavestream.io/configuration/) | Operators         |
| [Architecture docs](https://docs.weavestream.io/overview/architecture/) | Operators + devs  |
| [Development setup](https://docs.weavestream.io/development/) | Contributors      |
| [Releasing docs](https://docs.weavestream.io/development/releasing/) | Maintainers       |
| [CHANGELOG.md](CHANGELOG.md)                  | Everyone          |
| [docs.weavestream.io/getting-started](https://docs.weavestream.io/getting-started/) | New operators |
| [weavestream.io/features/assets](https://weavestream.io/features/assets) | Everyone |
| [weavestream.io/features/passwords](https://weavestream.io/features/passwords) | Everyone |
| [weavestream.io/features/articles](https://weavestream.io/features/articles) | Everyone |
| [weavestream.io/features/ipam](https://weavestream.io/features/ipam) | Everyone |
| [weavestream.io/features/integrations](https://weavestream.io/features/integrations) | Everyone |
| [weavestream.io/guides/security-center](https://weavestream.io/guides/security-center) | Everyone |
| [weavestream.io/overview/changelog](https://weavestream.io/overview/changelog) | Everyone |

## Project status

Weavestream is tagged releases only — pin `WEAVESTREAM_VERSION` in your
`.env` and treat `:latest` as unstable. The first public release is
**v1.0.0**. See the [releases page](https://github.com/Weavestream/Weavestream/releases)
for published images.

## Contributing

Bug reports, feature requests, and PRs are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first, and remember that
contributions are accepted under the project's AGPL-3.0 license.

Security issues go through [SECURITY.md](SECURITY.md), not the public
issue tracker.

See also [weavestream.io/security/disclosure](https://weavestream.io/security/disclosure).

## License

Weavestream is distributed under the **GNU AGPL-3.0-or-later** license
— see [LICENSE](LICENSE). If you run a modified Weavestream as a
network-accessible service, AGPL §13 requires you to offer the modified
source to its users.
