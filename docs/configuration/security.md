---
label: Security Configuration
icon: shield
order: 700
description: Hardening options, rate limits, authentication tuning, and CORS configuration.
---

# Security Configuration

Most of Weavestream's security hardening is on by default. This page documents the knobs available for tuning and the reasoning behind the defaults.

## Rate Limiting

| Variable | Default | Effect |
|---|---|---|
| `GLOBAL_RATE_LIMIT_PER_MIN` | `600` | Requests per minute per user (authenticated) or per IP (unauthenticated). Raise for high-traffic instances; lower for stricter hardening. |
| `AUTH_RATE_LIMIT_PER_MIN` | `5` | Login attempts per IP + per email per minute. Keep this low. |
| `LOCKOUT_MAX_FAILURES` | `5` | Failed logins before account soft-lock. |
| `LOCKOUT_WINDOW_MIN` | `15` | Minutes a locked account remains inaccessible. |

!!!warning Don't raise auth rate limits in production
The auth rate limits protect against credential stuffing and brute-force attacks. Raising them significantly reduces their protective value.
!!!

## Password Hashing (Argon2)

| Variable | Default | Notes |
|---|---|---|
| `ARGON2_MEMORY_KB` | `65536` (64 MB) | Memory cost. Do not lower below `65536` in production. Higher is more resistant to GPU attacks. |
| `ARGON2_ITERATIONS` | `3` | Time cost. Increasing this slows login — test impact before changing. |
| `ARGON2_PARALLELISM` | `1` | Parallelism. Match to available API CPU cores for maximum throughput. |

## Session Management

| Variable | Default | Notes |
|---|---|---|
| `SESSION_MAX_AGE_DAYS` | `30` | How long a session cookie lives. Shorten for higher-security environments. |
| `ACCESS_TOKEN_TTL_MIN` | `15` | JWT lifetime in minutes. A compromised token is valid for at most this long after session revocation. |
| `SESSION_COOKIE_NAME` | `ws_session` | Rename if you run multiple Weavestream instances on the same domain. |

## Client IP Attribution

| Variable | Default | Notes |
|---|---|---|
| `TRUST_PROXY_HOPS` | `1` | Number of trusted reverse-proxy hops between the client and API. |

`req.ip` is resolved from the verified `X-Forwarded-For` chain using `TRUST_PROXY_HOPS`.
Set this to match your real topology (for example: `2` for edge proxy -> web -> api, `3` for CDN -> edge -> web -> api).

Setting it too high can allow forged client IP attribution. Setting it too low collapses traffic behind one proxy IP, weakening rate-limit and lockout protections.

| Topology | `TRUST_PROXY_HOPS` |
|---|---|
| `compose.yml` default: `web` -> `api` | `1` |
| Edge proxy: Caddy, Traefik, or Nginx -> `web` -> `api` | `2` |
| CDN -> edge proxy -> `web` -> `api` | `3` |

Every trusted proxy hop must overwrite or append to `X-Forwarded-For` and set `X-Forwarded-Proto` correctly.

## Content Security Policy

Weavestream configures a strict CSP via Helmet:

- Scripts are restricted to same-origin and a per-request nonce
- Inline scripts are disallowed except via the nonce
- `img-src` / `connect-src` are same-origin only — uploaded media is streamed through the API on the web origin, so no third-party file host needs to be allowlisted

## Egress / SSRF Guard

Every server-side outbound HTTP request goes through a safety guard that blocks loopback, RFC1918/private, link-local, multicast, and cloud-metadata addresses.

| Variable | Default | Notes |
|---|---|---|
| `EGRESS_ALLOW_PRIVATE_NETWORKS` | `false` | Set `true` only for lab/single-host installs to disable the blocklist. |
| `EGRESS_ALLOWED_PRIVATE_CIDRS` | _(empty)_ | Comma-separated CIDRs allowed while blocklist remains enabled. |

Use `EGRESS_ALLOWED_PRIVATE_CIDRS` for surgical allowlists (example: `10.42.0.0/16`) when integrating with on-prem systems.
Each blocked request is audited as `security.egress.blocked` and appears in **Admin -> Security -> Egress blocks**.

## CSRF Protection

Weavestream uses a **double-submit cookie** pattern:

1. A signed CSRF token is set in a cookie (`CSRF_SIGNING_KEY`)
2. The same value is expected in an `X-CSRF-Token` request header
3. Server compares and rejects mismatches

This is transparent to users and does not require configuration beyond ensuring `CSRF_SIGNING_KEY` is set to a random secret.

## Health Endpoints

`GET /health` is now liveness-only and returns `{ "status": "ok" }`.

Detailed diagnostics moved to authenticated endpoints:

- `GET /health/ready` (authenticated readiness checks)
- `GET /health/queues` (authenticated and requires `AUDIT_READ`)

## Admin Security Controls

- **Security Center (`/admin/security`)** provides visibility into login events, active lockouts, rate-limit blocks, active sessions, and egress blocks.
- Access requires `SECURITY_READ` capability (or `SUPER_ADMIN`).
- **IP rules (`/admin/ip-rules`)** allow global ALLOW/DENY rules for IPv4/CIDR with priority ordering.
- Managing IP rules requires `IP_RULE_MANAGE` capability.
- Changes are audited (`security.ip_rule.create`, `security.ip_rule.update`, `security.ip_rule.delete`).

## HIBP Breach Checking

| Variable | Default | Notes |
|---|---|---|
| `HIBP_ENABLED` | `true` | Disable for air-gapped deployments that cannot reach `api.pwnedpasswords.com`. |

The check uses k-anonymity — only the first 5 characters of the SHA-1 hash leave the server.

## `NODE_ENV`

Setting `NODE_ENV=development` is intended for local development only. In development mode:

- Stack traces are included in error responses
- Some CSP directives are relaxed
- Some cookie flags may be disabled

**Never run `NODE_ENV=development` in production.**
