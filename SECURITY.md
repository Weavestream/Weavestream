# Security Policy

## Supported versions

Weavestream is currently in active development. Security fixes ship on the
latest minor release line.

| Version | Supported           |
| ------- | ------------------- |
| 1.x     | :white_check_mark:  |
| < 1.0   | :x:                 |

We recommend pinning `WEAVESTREAM_VERSION` to a specific patch release in
production and following the [CHANGELOG](CHANGELOG.md) for upgrade notes.

## Dependency patch SLA

Production dependency advisories are surfaced two ways: the CI `audit` job
(`pnpm audit --prod --audit-level=high`) blocks merges on new high/critical
production advisories, and Dependabot opens grouped update PRs weekly. Once an
advisory affecting a production dependency is confirmed, we target the
following times from confirmation to a tagged patch release:

| Severity | Target to patched release       |
| -------- | ------------------------------- |
| Critical | 72 hours                        |
| High     | 7 days                          |
| Moderate | 30 days                         |
| Low      | next scheduled dependency cycle |

These targets apply to advisories with a realistic exploitation path against a
default deployment. An advisory that is not reachable in our configuration (for
example, a build-time-only dependency) may be deferred to the next dependency
cycle with a note recorded in
[CHANGELOG-SECURITY.md](CHANGELOG-SECURITY.md).

## Reporting a vulnerability

**Please do not open a public issue for suspected security problems.**

Instead, use GitHub's [private vulnerability reporting](https://github.com/Weavestream/Weavestream/security/advisories/new)
feature. You can expect:

- An acknowledgement within **72 hours**.
- A coordinated disclosure timeline — typically 30–90 days depending on
  severity and complexity — with a patch, advisory, and credit (unless
  you request anonymity).

When reporting, please include:

- A clear description of the vulnerability and its impact.
- Minimal reproduction steps or proof-of-concept.
- The Weavestream version (`WEAVESTREAM_VERSION` from your `.env`) and
  deployment shape (Docker Compose, Kubernetes, etc.).
- Any suggested mitigations if you have them.

## Scope

In scope:

- The code in this repository (`apps/`, `packages/`, `docker/`, `scripts/`).
- The published container images at `ghcr.io/weavestream/weavestream-*`.
- The default `compose.yml` deployment topology.

Out of scope:

- Vulnerabilities in third-party dependencies that are already tracked
  upstream (please report those to the upstream project).
- Social-engineering, physical attacks, or denial-of-service by resource
  exhaustion against your own instance.
- Issues that require prior compromise of the host or database.

Thank you for helping keep Weavestream and its users safe.
