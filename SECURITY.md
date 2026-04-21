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
