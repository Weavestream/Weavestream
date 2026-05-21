---
label: Environment Variables
icon: terminal
order: 900
description: Complete reference for all Weavestream environment variables.
---

# Environment Variables

All runtime configuration is environment-driven. The `.env.example` file in the repository is the authoritative template. This page explains every variable and its operational impact.

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
| `JWT_SIGNING_KEY_KID` | Key ID embedded in the JWT header. Bump on rotation. |
| `JWT_PREVIOUS_KEYS` | Comma-separated `kid:key` pairs kept valid during rotation. |
| `SESSION_COOKIE_NAME` | Cookie name. Default: `ws_session`. |
| `SESSION_MAX_AGE_DAYS` | Session cookie lifetime in days. |
| `ACCESS_TOKEN_TTL_MIN` | Access JWT TTL in minutes. Default: `15`. |
| `MFA_ENCRYPTION_KEY` | AES-256 key for TOTP secrets at rest. |
| `COOKIE_SIGNING_KEY` | HMAC key for signed cookies. |
| `CSRF_SIGNING_KEY` | HMAC key for double-submit CSRF tokens. |

## Argon2 (Password Hashing)

| Variable | Default | Notes |
|---|---|---|
| `ARGON2_MEMORY_KB` | `65536` | Memory cost. Do not lower below `65536` in production. |
| `ARGON2_ITERATIONS` | `3` | Time cost (iterations). |
| `ARGON2_PARALLELISM` | `1` | Parallelism factor. |

## Rate Limiting

| Variable | Default | Notes |
|---|---|---|
| `GLOBAL_RATE_LIMIT_PER_MIN` | `600` | Requests per minute per authenticated user ID (falls back to client IP for unauthenticated requests). |
| `AUTH_RATE_LIMIT_PER_MIN` | `5` | Login attempts per minute, per IP and per email. |
| `LOCKOUT_MAX_FAILURES` | `5` | Failed login attempts before account soft-lock. |
| `LOCKOUT_WINDOW_MIN` | `15` | Soft-lock duration in minutes. |

!!!note Proxy-aware rate limiting
The global throttler keys on `req.user.id` for authenticated requests. For unauthenticated requests, it falls back to the real client IP. Configure `TRUST_PROXY_HOPS` to match the number of trusted proxy hops between the browser and API.
!!!

## Password Vault Encryption

| Variable | Notes |
|---|---|
| `PASSWORD_ENCRYPTION_KEY` | AES-256-GCM key for credential encryption. 32 bytes, base64-encoded. |
| `PASSWORD_ENCRYPTION_KEY_KID` | Key ID stamped on each ciphertext blob (e.g. `2026-01`). Bump on rotation. |
| `PASSWORD_PREVIOUS_KEYS` | Comma-separated `kid:key` pairs from previous rotations. |

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
| `ALLOWED_UPLOAD_MIME` | Comma-separated MIME allowlist. The default includes images, PDFs, documents, archives, scripts, and data files. Add cautiously. |

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
| `INTEGRATION_SECRET_KEY_KID` | Key ID stamped on each ciphertext blob (e.g. `2026-01`). Bump on rotation. Default: `2026-01`. |
| `INTEGRATION_PREVIOUS_KEYS` | Comma-separated `kid:key` pairs from previous rotations. Old blobs decrypt seamlessly and re-encrypt on next mutation. |

### Sync Scheduling

| Variable | Default | Notes |
|---|---|---|
| `INTEGRATION_SYNC_DEFAULT_CRON` | `0 */4 * * *` | 5-field cron expression used as the global default sync schedule. Set to `off` to disable all scheduled syncs workspace-wide (manual runs from **Admin → Integrations** still work). Integrations with a per-record `syncCron` override this value. |

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
