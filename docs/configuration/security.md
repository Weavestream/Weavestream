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
| `TRUST_PROXY_HOPS` | `1` | Number of trusted reverse-proxy hops **between the internet and the `web` container** (i.e. the operator-managed edge tier). |

The web tier reads `TRUST_PROXY_HOPS` to resolve the real client IP from the inbound `X-Forwarded-For` chain — which is the only chain an attacker can influence — and then forwards a single sanitized entry to the API. The API does not use this knob: it honors `X-Forwarded-For` only when the TCP peer is on the private docker bridge (loopback / link-local / unique-local), which only the `web` container is. An attacker who somehow reaches `api:4000` directly has their `X-Forwarded-For` ignored and falls back to the socket peer.

Count proxies **in front of `web`** when setting this value:

| Topology | `TRUST_PROXY_HOPS` |
|---|---|
| Edge proxy (Caddy, Traefik, Nginx, …) → `web` → `api` | `1` (default) |
| CDN (Cloudflare, …) → edge proxy → `web` → `api` | `2` |
| `web` is directly internet-facing (no edge) | `0` — IP attribution degrades to a sentinel since Next.js doesn't expose the socket peer in App Router server contexts. Run an edge proxy in production. |

Setting this too high lets a malicious upstream forge the client IP; setting it too low collapses every request behind your edge into a single throttler bucket. Every trusted edge proxy must set `X-Forwarded-Proto` and either overwrite or append to `X-Forwarded-For`.

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
- Rules are enforced at **both** layers: the API rejects every API call from a denied IP with `403`, and the Next.js proxy rejects HTML page renders with `403` (so a blocked IP doesn't see a login form). The page-layer enforcement polls the API every 30 seconds, so admin changes propagate to page renders within that window; API enforcement is immediate. If the API is unreachable the page layer fails open (last-known ruleset, or no rules on cold start) — matching the API's own fail-open posture so a broken backend can't lock everyone out.
- Static asset paths under `/_next/*` are excluded from the page-layer block (they bypass the Next.js proxy by design). A blocked IP can still pull anonymous JS/CSS bundles but cannot reach any HTML page or API endpoint. The internal poll endpoint (`GET /api/v1/ip-rules/active`) is unauthenticated but restricted to private TCP peers (loopback, link-local, RFC1918, IPv6 ULA) — a deployment where `web` and `api` share a Docker bridge or private network already satisfies this; routing `web → api` over the public internet is not supported.

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
