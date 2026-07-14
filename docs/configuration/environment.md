---
label: Environment Variables
icon: terminal
order: 900
description: Complete reference for all Weavestream environment variables.
---

# Environment Variables

All runtime configuration is environment-driven. This page is the **complete reference** for every variable Weavestream reads; the `.env.example` file in the repository is the minimal getting-started template.

Variables fall into two tiers:

- **Required** — the app refuses to boot without them: `APP_URL`, `API_URL`, `DATABASE_URL`, `REDIS_URL`, and the encryption/signing keys (with their `_KID`s). These ship in `.env.example`.
- **Optional** — everything else has a safe built-in default and can be omitted. `.env.example` carries a short commented block of the most commonly-tuned ones; the rest are documented here and only need to be set to override a default.

Each table lists the default (where one exists) and its operational impact. Valid ranges are enforced at boot by the schema in `packages/shared/src/env.ts`.

## Release Pinning

| Variable | Default | Notes |
|---|---|---|
| `WEAVESTREAM_VERSION` | `latest` | Image tag pulled from `ghcr.io/weavestream/weavestream-*`. **Always pin in production.** |

## Host Ports

The default `compose.yml` only exposes the web UI. Postgres and Redis stay internal.

| Variable | Default | Service |
|---|---|---|
| `WEB_HOST_PORT` | `3000` | Next.js web UI |

Postgres and Redis are not published to the host by the production compose file. Inspect them with `docker compose exec postgres psql ...` and `docker compose exec redis redis-cli ...`.

For local development, `compose.build.yml` publishes Postgres on `5434` and Redis on `6381`. See [Development Setup](/development/) for the contributor workflow.

## Core URLs

| Variable | Example | Notes |
|---|---|---|
| `APP_URL` | `https://docs.example.com` | Public web origin. Used for cookie domain and CORS allowlisting. |
| `API_URL` | `https://docs.example.com/api` | Public API origin. Must be reachable from browsers. |
| `NODE_ENV` | `production` | `development` enables verbose errors and disables some hardening. |

## Postgres

| Variable | Notes |
|---|---|
| `POSTGRES_USER` | Database role name. Default: `weavestream`. |
| `POSTGRES_PASSWORD` | Must match the password embedded in `DATABASE_URL`. |
| `POSTGRES_DB` | Database name. |
| `DATABASE_URL` | Full connection string. Inside compose, host is `postgres:5432`. |

## Redis

| Variable | Notes |
|---|---|
| `REDIS_PASSWORD` | Must match the password embedded in `REDIS_URL`. |
| `REDIS_URL` | Full Redis URL. Inside compose: `redis://:<password>@redis:6379/0`. |

## Authentication & Sessions

Generate all signing keys with `./scripts/keygen.sh`. Each key is 32 random bytes in base64.

| Variable | Notes |
|---|---|
| `JWT_SIGNING_KEY` | HS256 signing key for access tokens. |
| `JWT_SIGNING_KEY_KID` | Key ID embedded in the JWT header. Optional; default `1`. Bump on rotation. |
| `JWT_PREVIOUS_KEYS` | Comma-separated `kid:key` pairs kept valid during rotation. |
| `SESSION_COOKIE_NAME` | Cookie name. Default: `ws_session`. |
| `SESSION_MAX_AGE_DAYS` | Session cookie lifetime in days. |
| `ACCESS_TOKEN_TTL_MIN` | Access JWT TTL in minutes. Default: `15`. |
| `MFA_ENCRYPTION_KEY` | AES-256 key for TOTP secrets at rest. |
| `COOKIE_SIGNING_KEY` | HMAC key for signed cookies. |
| `CSRF_SIGNING_KEY` | HMAC key for double-submit CSRF tokens. |
| `STEP_UP_TTL_SEC` | Optional. Seconds a step-up re-authentication stays valid before a sensitive admin action re-prompts. Default: `900` (15 min). Range: 60–3600. |

## Argon2 (Password Hashing)

Advanced; the defaults follow OWASP guidance and rarely need tuning.

| Variable | Default | Notes |
|---|---|---|
| `ARGON2_MEMORY_KB` | `65536` | Memory cost in KiB. Do not lower below `65536` in production. Range: 16,384–1,048,576. |
| `ARGON2_ITERATIONS` | `3` | Time cost (iterations). Range: 1–20. |
| `ARGON2_PARALLELISM` | `4` | Parallelism factor (lanes). Range: 1–16. |

## Rate Limiting

| Variable | Default | Notes |
|---|---|---|
| `GLOBAL_RATE_LIMIT_PER_MIN` | `600` | Requests per minute per authenticated user ID (falls back to client IP for unauthenticated requests). |
| `AUTH_RATE_LIMIT_PER_MIN` | `5` | Login attempts per minute, per (IP, email) pair. |
| `LOCKOUT_MAX_FAILURES` | `5` | Failed login attempts before account soft-lock. |
| `LOCKOUT_WINDOW_MIN` | `15` | Soft-lock duration in minutes. |

!!!note Proxy-aware rate limiting
The global throttler keys on `req.user.id` for authenticated requests. For unauthenticated requests, it falls back to the real client IP. Configure `TRUST_PROXY_HOPS` to match the number of trusted proxy hops between the browser and API.
!!!

## Reverse Proxy & Network

| Variable | Default | Notes |
|---|---|---|
| `TRUST_PROXY_HOPS` | `1` | Trusted reverse-proxy hops in front of the `web` container. `1` = one reverse proxy (default), `2` = CDN → proxy, `0` = `web` exposed directly. Setting it too high lets an upstream forge the client IP; too low collapses every request into one rate-limit bucket. Range: 0–10. See [TLS & Reverse Proxy](/deployment/tls/). |
| `WEB_ALLOWED_DEV_ORIGINS` | _(empty)_ | **Dev only**, ignored in production builds. Comma-separated origins allowed to fetch Next.js dev resources (HMR) from a non-localhost host. See [Development Setup](/development/). |

## Egress / SSRF Guard

Every server-side outbound HTTP request (integration drivers, RDAP/HIBP probes, domain checks) flows through `safeFetch`, which refuses to connect to loopback, RFC1918, link-local, or cloud-metadata (`169.254.169.254`) targets. Each refusal is recorded in the audit log as `security.egress.blocked` and surfaced under **Admin → Security → Egress blocks**.

| Variable | Default | Notes |
|---|---|---|
| `EGRESS_ALLOW_PRIVATE_NETWORKS` | `false` | Set to `true` to disable the entire guard. Use only on lab / single-host installs where the API legitimately talks to sibling containers over a flat private network and there are no operator-supplied URLs. |
| `EGRESS_ALLOWED_PRIVATE_CIDRS` | _(empty)_ | Surgical alternative — comma-separated CIDRs permitted even when the global block is on, e.g. `10.42.0.0/16,192.168.50.0/24` for on-prem RMM endpoints. |

## Password Vault Encryption

| Variable | Notes |
|---|---|
| `PASSWORD_ENCRYPTION_KEY` | AES-256-GCM key for credential encryption. 32 bytes, base64-encoded. |
| `PASSWORD_ENCRYPTION_KEY_KID` | Key ID stamped on each ciphertext blob. Optional; default `1`. Bump on rotation. |
| `PASSWORD_PREVIOUS_KEYS` | Comma-separated `kid:key` pairs from previous rotations. |

## Email (SMTP) Credential Encryption

The SMTP password configured under **Admin → Settings → Email** is encrypted at rest with the same kid-tagged AES-256-GCM scheme as the password vault, under a separate key so mail credentials rotate independently. Generate the key with `./scripts/keygen.sh`.

| Variable | Notes |
|---|---|
| `SMTP_SECRET_KEY` | AES-256-GCM key for the saved SMTP password. 32 bytes, base64-encoded. |
| `SMTP_SECRET_KEY_KID` | Key ID stamped on the ciphertext. Optional; default `1`. Bump on rotation. |
| `SMTP_PREVIOUS_KEYS` | Comma-separated `kid:key` pairs from previous rotations. |

## HaveIBeenPwned

| Variable | Default | Notes |
|---|---|---|
| `HIBP_ENABLED` | `true` | Set to `false` to disable the outbound breach check. Useful for air-gapped deployments. |

## File Storage

Uploaded files (attachments, thumbnails, logos, export PDFs) live on the local filesystem under a single host-bind-mounted directory, isolated per tenant by directory:

```text
${FILE_STORAGE_DIR}/<companyId>/uploads/<uploadId>/<filename>
${FILE_STORAGE_DIR}/<companyId>/thumbs/<uploadId>.webp
${FILE_STORAGE_DIR}/<companyId>/exports/<exportId>.pdf
```

| Variable | Default | Notes |
|---|---|---|
| `FILE_STORAGE_DIR` | `./data/files` | Storage root, defaults to a path under `DATA_DIR` so files sit alongside `./data/postgres` and `./data/redis`. `compose.yml` bind-mounts `${DATA_DIR}/files` into the api+worker containers and sets this env var for you, so leave it unset for the standard install. Browsers never read the directory directly — every access streams through the API. |

Every thumbnail, attachment, logo, and export PDF is streamed through the API on the same origin as the web app. A single reverse-proxy virtual host covers the whole application; there is no separate `files.example.com` host to configure.

## Uploads

| Variable | Notes |
|---|---|
| `MAX_UPLOAD_MB` | Server-enforced upload size cap in megabytes. Default: `25`. |
| `NEXT_PUBLIC_MAX_UPLOAD_MB` | Client-side mirror. Keep in sync with `MAX_UPLOAD_MB`. |
| `ALLOWED_UPLOAD_MIME` | Comma-separated MIME allowlist. The default includes images, PDFs, documents, archives, scripts, and data files. Add cautiously. Browser-active types (`text/html`, `application/xhtml+xml`, `image/svg+xml`, and any `image/*+xml`) are rejected at startup regardless of this setting — they can execute script when rendered inline. |

## Data Directory

| Variable | Default | Notes |
|---|---|---|
| `DATA_DIR` | `./data` | Host path for persistent data. Set to an absolute path for NAS deployments (e.g. `/volume1/docker/weavestream`). |

## Logging

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | One of: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

## Integrations

Settings for the integration sync engine and provider drivers. Generate encryption keys with `./scripts/keygen.sh`.

### Credential Encryption

Integration credential bundles (API tokens, secrets) are encrypted with the same kid-tagged envelope scheme as the password vault, but under a separate key so each can be rotated independently.

| Variable | Notes |
|---|---|
| `INTEGRATION_SECRET_KEY` | AES-256-GCM key for integration credentials. 32 bytes, base64-encoded. |
| `INTEGRATION_SECRET_KEY_KID` | Key ID stamped on each ciphertext blob. Optional; default `1`. Bump on rotation. |
| `INTEGRATION_PREVIOUS_KEYS` | Comma-separated `kid:key` pairs from previous rotations. Old blobs decrypt seamlessly and re-encrypt on next mutation. |

### Sync Scheduling

| Variable | Default | Notes |
|---|---|---|
| `INTEGRATION_SYNC_DEFAULT_CRON` | `*/15 * * * *` | 5-field cron expression used as the global default sync schedule. Set to `off` to disable inherited/default schedules workspace-wide; integrations with an explicit per-record `syncCron` still run on that schedule. Manual runs from **Admin → Integrations** continue to work. |

### Concurrency

| Variable | Default | Notes |
|---|---|---|
| `INTEGRATION_SYNC_ORCHESTRATOR_CONCURRENCY` | `2` | Parallel orchestrator (fan-out) jobs. Valid range: 1–50. |
| `INTEGRATION_SYNC_MAPPING_CONCURRENCY` | `5` | Parallel per-mapping (fetch + upsert) jobs. Valid range: 1–100. |

### HTTP Behaviour

These settings apply to every outbound HTTP call made by integration drivers (e.g. Action1 API requests). Retries use exponential backoff on `429` and `5xx` responses.

| Variable | Default | Notes |
|---|---|---|
| `INTEGRATION_HTTP_TIMEOUT_MS` | `30000` | Socket timeout per request in milliseconds. Valid range: 1,000–120,000. |
| `INTEGRATION_HTTP_MAX_RETRIES` | `5` | Maximum retry attempts after a retriable failure. Valid range: 0–10. |
| `INTEGRATION_HTTP_BACKOFF_MS` | `1000` | Base backoff in milliseconds. Each retry sleeps `backoffMs × 2ⁿ`. Valid range: 100–60,000. |

## Backups

Scheduled Postgres dumps (admin **Backups** page) and their `*.manifest.json` sidecars.

| Variable | Default | Notes |
|---|---|---|
| `BACKUP_STORAGE_DIR` | `./data/backup` | Destination for dumps. Like `FILE_STORAGE_DIR`, `compose.yml` bind-mounts `${DATA_DIR}/backup` and sets this for you — leave unset on the standard install. The API mounts it read-only (downloads); the worker mounts it read-write (dump + prune). |
| `BACKUP_JOB_LOCK_MINUTES` | `360` | Minutes a single backup job may run before BullMQ treats its lock as stalled. The 6 h default covers sub-GB up to tens-of-GB databases on slow/NAS disks. Range: 5–1440. |

## Background Jobs & Schedulers

Repeatable BullMQ jobs. Every `*_CRON` takes a standard 5-field cron expression, or the literal string `off` to disable scheduled runs (manual / on-demand runs still work).

### Domain & SSL Monitor

| Variable | Default | Notes |
|---|---|---|
| `DOMAIN_CHECK_CRON` | `17 3 * * *` | Schedule for the WHOIS/DNS/TLS expiry sweep. `off` disables it. |
| `DOMAIN_CHECK_CONCURRENCY` | `5` | Parallel domain checks. Range: 1–100. |
| `DOMAIN_CHECK_TIMEOUT_MS` | `10000` | Per-check WHOIS/DNS/TLS timeout (ms). Range: 1,000–60,000. |
| `DOMAIN_CHECK_ATTEMPTS` | `3` | Retry attempts per check. Range: 1–10. |
| `DOMAIN_CHECK_BACKOFF_MS` | `30000` | Base retry backoff (ms). Range: 1,000–600,000. |
| `RDAP_BOOTSTRAP_CACHE_HOURS` | `24` | How long to cache the IANA RDAP bootstrap registry. Range: 1–720. |
| `HTTP_CHECK_TIMEOUT_MS` | `8000` | HTTP probe timeout for the `WEBSITE_DOWN` evaluator and domain checks (ms). Range: 1,000–60,000. |

### Alerts

| Variable | Default | Notes |
|---|---|---|
| `ALERTS_SCAN_CRON` | `*/5 * * * *` | Schedule for time/state-based alert evaluation (expiration lists, website-down). Real-time record/password alerts do not depend on this. `off` disables scheduled scans. |

### Upload Reaper

| Variable | Default | Notes |
|---|---|---|
| `UPLOAD_REAPER_CRON` | `7 4 * * *` | Schedule for purging soft-deleted uploads. `off` disables it. |
| `UPLOAD_REAPER_RETENTION_DAYS` | `30` | Grace period before a soft-deleted upload is purged. Range: 1–365. |
| `UPLOAD_REAPER_BATCH_SIZE` | `500` | Max rows purged per tick (bounds the advisory-lock hold window). Shared between the soft-delete purge and the orphan-directory sweep. Range: 1–5,000. |
| `UPLOAD_ORPHAN_MIN_AGE_HOURS` | `24` | Minimum age before an upload directory with no database row (an upload that was started but never confirmed) is removed from disk. Range: 1–720. The worker needs read-write access to `FILE_STORAGE_DIR` for this sweep; the shipped `compose.yml` already mounts it read-write, so this only matters for custom deployments. |

### Worker Concurrency

| Variable | Default | Notes |
|---|---|---|
| `WORKER_CONCURRENCY_GLOBAL` | `10` | Global cap on concurrent jobs the worker process runs. Range: 1–500. |
