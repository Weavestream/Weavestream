---
label: Responsible Disclosure
icon: report
order: 500
description: How to report security vulnerabilities in Weavestream.
---

# Responsible Disclosure

## Reporting a Vulnerability

**Please do not open a public GitHub issue for suspected security problems.**

Use GitHub's [private vulnerability reporting](https://github.com/Weavestream/Weavestream/security/advisories/new) feature to report the issue confidentially.

You can expect:

- An **acknowledgement within 72 hours**
- A **coordinated disclosure timeline** — typically 30–90 days depending on severity and complexity
- A **patch, advisory, and credit** upon resolution (unless you request anonymity)

## What to Include in Your Report

To help us reproduce and assess the issue quickly, please provide:

- A **clear description** of the vulnerability and its potential impact
- **Minimal reproduction steps** or a proof-of-concept
- The **Weavestream version** (`WEAVESTREAM_VERSION` from your `.env`) and deployment shape (Docker Compose, Kubernetes, etc.)
- Any **suggested mitigations** if you have them

## Scope

### In scope

- Code in this repository (`apps/`, `packages/`, `docker/`, `scripts/`)
- Published container images at `ghcr.io/weavestream/weavestream-*`
- The default `compose.yml` deployment topology

### Out of scope

- Vulnerabilities in third-party dependencies already tracked upstream — please report those to the upstream project
- Social engineering, physical attacks, or denial-of-service by resource exhaustion against your own instance
- Issues that require prior compromise of the host or database
- Findings from automated scanners without a verified proof-of-concept

## Supported Versions

Security fixes ship on the latest minor release line:

| Version | Supported |
|---|---|
| 1.x | ✅ Yes |
| < 1.0 | ❌ No |

We recommend pinning `WEAVESTREAM_VERSION` to a specific patch release and following the [changelog](/overview/changelog/) for upgrade notes.

## Thank You

Security research is valuable work. We appreciate researchers who take the time to report issues responsibly and work with us through the disclosure process. All eligible reporters receive credit in the security advisory unless they request otherwise.
