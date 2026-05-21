---
label: Threat Model
icon: shield-check
order: 900
description: Trust boundaries, attack surfaces, and mitigations in Weavestream's security design.
---

# Threat Model

Weavestream is designed for self-hosted deployment behind a reverse proxy. This page documents the trust boundaries and how each threat actor is mitigated.

## Deployment Boundary

```
Internet → TLS (reverse proxy) → web (Next.js) → api (NestJS)
                                                       ↕
                                                  postgres / redis
                                                       │
                                          (api & worker bind-mount
                                           ${DATA_DIR}/files for
                                           uploaded content)
```

- The reverse proxy terminates TLS. Weavestream does not.
- Postgres and Redis are **not exposed** to the host network in the default `compose.yml`.
- Uploaded files live on a host-bind-mounted directory shared by `api` and `worker`. The directory has no network surface — browsers always go through the API's streaming endpoints.
- The `api` and `worker` are the only services with database credentials.
- Health endpoints expose no version or backend diagnostics to unauthenticated requests.

## Threat Actors

### External Attacker (Unauthenticated)

Someone without an account attempting to access or enumerate data.

**Mitigations:**

- Per-IP and per-email **rate limiting** on the login endpoint (5 attempts/minute)
- **Account soft-lock** after N failed logins (default 5, 15-minute window)
- **Generic 401 responses** — no indication of whether an account exists (prevents user enumeration)
- Mandatory **TOTP MFA** — password alone is insufficient
- Strict **Content-Security-Policy** (via Helmet)
- **`sameSite=lax` session cookies** — prevents CSRF cross-site submission
- **Global rate limiting** — 600 requests/minute per authenticated identity, per-IP fallback for unauthenticated
- **IP-based access rules** — admins can define global ALLOW/DENY rules for IP addresses and CIDR ranges
- **Centralized client-IP handling** — `TRUST_PROXY_HOPS` prevents `X-Forwarded-For` header spoofing
- **Reduced health endpoint exposure** — public `/health` returns only `{ "status": "ok" }`; diagnostics require authentication
- **SSRF/egress guard** — server-side HTTP calls cannot reach loopback, RFC1918, link-local, or cloud metadata addresses

### Client Portal User

A `CLIENT_USER` attempting to access data beyond their permitted tenant or see hidden fields.

**Mitigations:**

- Client users are **scoped to specific tenants** via memberships. No admin routes are accessible.
- Fields marked `visibleToClients=false` are **stripped server-side** before the response is sent — not merely hidden in the UI.
- Client users cannot access any `/admin` route — the API returns 403.
- A client user cannot escalate to `OPERATOR` without a `SUPER_ADMIN` changing their global role.

### Contractor with Expired Access

A `CONTRACTOR` whose membership has expired attempting to continue working.

**Mitigations:**

- Every API request checks `membership.expiresAt` against the current timestamp.
- Expired memberships return **403 Forbidden** immediately — no grace period.
- The contractor's account remains active (so they can log in and see the expiry message), but all tenant data access is blocked.

### Compromised Operator Account

An attacker who has obtained valid credentials and TOTP for an `OPERATOR` account.

**Mitigations:**

- The account is limited to the tenants the operator has memberships on.
- The **append-only audit log** records all mutations — the attacker cannot cover their tracks.
- **Session revocation** is immediate — a `SUPER_ADMIN` can terminate all active sessions for the compromised account via the Security Center.
- JWTs are **15 minutes** — the attacker's token expires quickly after revocation.
- The **reveal audit trail** records every credential decryption, so exposure scope is visible after the fact.
- **Security Center** provides real-time visibility into login activity, active sessions, and lockouts to detect compromise early.
- **IP allow/deny rules** can block access from unauthorized source networks even with valid credentials.

### Insider Threat (Operator)

A legitimate `OPERATOR` attempting to tamper with audit history or exfiltrate data.

**Mitigations:**

- The audit log is **append-only at the database-role level**. The application's database role has no `UPDATE` or `DELETE` permission on the audit table.
- Rewriting history requires **Postgres superuser access** — not available through the application.
- Bulk data extraction is detectable through the audit log (mass reads are logged).
- `OPERATOR_READONLY` memberships can be used to give read-only access to sensitive tenants.

### Storage Layer IDOR

An application-layer bug allowing cross-tenant file access.

**Mitigations:**

- Each tenant has a **dedicated directory** under `${FILE_STORAGE_DIR}/<tenantId>/`.
- The storage layer rejects keys that contain `..`, leading slashes, or null bytes, and re-asserts that every resolved path stays inside the tenant directory before opening a file. A code-level IDOR that forgets to scope by `companyId` would be caught by this defense-in-depth check.
- Browsers never read the directory directly — every access streams through the API, which authorizes the request against the requested tenant before opening the file.

## What Weavestream Does Not Protect Against

- **Physical host compromise** — if an attacker has host-level access, all database content and encryption keys are exposed. Use full-disk encryption on the host.
- **Postgres superuser access** — a Postgres superuser can read all data and rewrite the audit log. Protect the Postgres password and restrict superuser access.
- **Compromise of the `.env` file** — the `.env` file contains all encryption keys. Protect it with filesystem permissions (readable only by root or the Docker daemon process).
- **Side-channel attacks** — timing attacks on cryptographic operations are not specifically mitigated beyond library defaults.
- **SSRF via integrations** — while the egress guard blocks private addresses by default, operators can punch holes via `EGRESS_ALLOWED_PRIVATE_CIDRS`. Review this setting carefully when integrating with on-prem RMM endpoints.

## Cryptographic Choices

| Primitive | Algorithm | Why |
|---|---|---|
| Password hashing | Argon2id | Memory-hard; resistant to GPU/ASIC attacks |
| Credential encryption | AES-256-GCM | NIST-standard authenticated encryption |
| JWT signing | HS256 | Symmetric; sufficient for server-issued tokens |
| TOTP | HOTP/TOTP (RFC 6238) | Industry-standard second factor |
| Breach check | SHA-1 (HIBP k-anonymity) | Required by HIBP API protocol; not used for security |
| Cookie signing | HMAC-SHA256 | Standard signed cookie integrity |
