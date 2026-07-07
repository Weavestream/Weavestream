---
label: Security
icon: shield
order: 300
description: Security architecture, threat model, and responsible disclosure.
---

# Security

Weavestream is built with a security-first design. This section documents the threat model, authentication system, encryption approach, audit trail, and responsible disclosure policy.

## Security Sections

- [Threat Model](/security/threat-model/) — trust boundaries, attack surfaces, and mitigations
- [Authentication](/security/authentication/) — login flow, MFA, session management, and lockout
- [Encryption](/security/encryption/) — credential encryption, key management, and TOTP
- [Audit Log](/security/audit-log/) — tamper-resistant mutation history
- [Data Retention](/security/data-retention/) — where derived plaintext copies live and how to remediate them
- [Responsible Disclosure](/security/disclosure/) — how to report vulnerabilities

## Security Principles

**Defence in depth.** No single control is relied upon exclusively. Rate limiting, MFA, RBAC, audit logging, and encryption all reinforce each other.

**Minimal attack surface.** No built-in TLS (reduces parser attack surface), no outbound email (no SMTP credential exposure), no public registration (invite-only reduces enumeration risk), no webhook callbacks (no SSRF surface).

**Operator-controlled.** No telemetry, no licence checks, no cloud calls (except the optional HIBP breach check). The operator controls every network path.

**Auditability.** The append-only audit log is protected at the database-role level. Even a compromised operator account cannot rewrite history.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security problems.**

Use GitHub's [private vulnerability reporting](https://github.com/Weavestream/Weavestream/security/advisories/new) feature. See [Responsible Disclosure](/security/disclosure/) for the full policy.
