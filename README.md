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

- **Tenant documentation.** Rich-text articles (Tiptap), folders, photo
  galleries, and configurable asset layouts per organization.
- **Password management.** Comprehensive credential storage with secure
  sharing and role-based access control.
- **Expiration tracking.** Monitor asset expiration dates (licenses,
  warranties, SSL certificates) with visibility into upcoming renewals.
- **Invite-only user management** with per-user setup tokens, forced
  TOTP MFA, and append-only audit logging across every mutation.
- **Two-layer RBAC.** Global roles combined with per-tenant memberships
  evaluated from a single permission matrix.
- **Client portals.** Each tenant gets a read-only portal where client
  users see only the articles and assets their role allows.
- **Bring-your-own storage.** MinIO-compatible object store with one
  bucket per tenant for tenant-level isolation at the storage layer.
- **Docker-first.** Three containers (`api`, `web`, `worker`) plus
  Postgres, Redis, and MinIO. Pulled, not built.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the threat model,
branding/terminology system, and repo layout.

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
backups — in [docs/INSTALL.md](docs/INSTALL.md).

Full guided walkthrough on the website: [weavestream.io/getting-started](https://weavestream.io/getting-started)

## Documentation

| Guide                                         | Audience          |
| --------------------------------------------- | ----------------- |
| [docs/INSTALL.md](docs/INSTALL.md)            | Operators         |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md)| Operators         |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)  | Operators + devs  |
| [docs/DEVELOPING.md](docs/DEVELOPING.md)      | Contributors      |
| [docs/RELEASING.md](docs/RELEASING.md)        | Maintainers       |
| [CHANGELOG.md](CHANGELOG.md)                  | Everyone          |
| [weavestream.io/getting-started](https://weavestream.io/getting-started) | New operators |
| [weavestream.io/features/assets](https://weavestream.io/features/assets) | Everyone |
| [weavestream.io/features/passwords](https://weavestream.io/features/passwords) | Everyone |
| [weavestream.io/features/articles](https://weavestream.io/features/articles) | Everyone |
| [weavestream.io/features/domains](https://weavestream.io/features/domains) | Everyone |
| [weavestream.io/features/domains](https://weavestream.io/features/domains) | Everyone |
| [weavestream.io/features/domains](https://weavestream.io/features/domains) | Everyone |
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
