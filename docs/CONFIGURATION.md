# Configuration reference

All runtime configuration is environment-driven. See
[`.env.example`](../.env.example) for the authoritative template.
This document explains each group and notes the operational impact.

## Release pinning

| Variable              | Default   | Notes                                                                 |
| --------------------- | --------- | --------------------------------------------------------------------- |
| `WEAVESTREAM_VERSION` | `latest`  | Image tag at `ghcr.io/weavestream/weavestream-*`. Pin in production. |

## Host ports

The default `compose.yml` deliberately publishes the smallest possible
surface so an operator can put the stack on the open internet behind a
reverse proxy without re-checking what is reachable.

| Variable                  | Default     | Published                        | Service                                                         |
| ------------------------- | ----------- | -------------------------------- | --------------------------------------------------------------- |
| `WEB_HOST_PORT`           | `3000`      | All interfaces                   | Next.js UI. Front this with HTTPS in production.                |
| `MINIO_HOST_PORT`         | `9100`      | `127.0.0.1` (loopback) by default| MinIO S3 API. Loopback is enough for a same-host reverse proxy. |
| `MINIO_HOST_BIND`         | `127.0.0.1` | n/a                              | Bind address for the MinIO S3 port. Set to `0.0.0.0` only if you genuinely need direct external access (rarely correct). |
| `MINIO_CONSOLE_HOST_PORT` | `9101`      | not published                    | Only honored when you layer [`compose.console.yml`](../compose.console.yml). |

Postgres and Redis are not published to the host. Operators inspect them
with `docker compose exec postgres psql ...` and
`docker compose exec redis redis-cli ...`. Contributors who run
`pnpm dev` against the compose stack layer
[`compose.build.yml`](../compose.build.yml), which re-publishes the
classic dev ports (`5434` Postgres, `6381` Redis, `9100`/`9101` MinIO).

If you need temporary host access to the MinIO admin console, layer the
console overlay:

```bash
docker compose -f compose.yml -f compose.console.yml up -d
```

Open it at <http://127.0.0.1:9101> on the deploy host or via an SSH
tunnel. The console authenticates with the same root credentials that
have programmatic access to every bucket, so do not expose it to the
LAN or the internet.

## Core URLs

| Variable    | Example                              | Notes                                                               |
| ----------- | ------------------------------------ | ------------------------------------------------------------------- |
| `APP_URL`   | `https://docs.example.com`           | Public web origin. Used for cookie domain and email links.          |
| `API_URL`   | `https://docs.example.com/api`       | Public API origin. Must be reachable from the browser.              |
| `NODE_ENV`  | `production`                         | `development` enables verbose errors and disables some hardening.   |

## Postgres

| Variable            | Notes                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `POSTGRES_USER`     | Role name. Default `weavestream`.                                    |
| `POSTGRES_PASSWORD` | Must match the password embedded in `DATABASE_URL`.                   |
| `POSTGRES_DB`       | Database name.                                                        |
| `DATABASE_URL`      | Full connection string. Inside compose, host is `postgres:5432`.     |

## Redis

| Variable         | Notes                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `REDIS_PASSWORD` | Must match the password embedded in `REDIS_URL`.                   |
| `REDIS_URL`      | Inside compose, `redis://:<pw>@redis:6379/0`.                      |

## Auth

Signing keys are 32 random bytes in base64. Generate with
[`scripts/keygen.sh`](../scripts/keygen.sh) /
[`scripts/keygen.ps1`](../scripts/keygen.ps1).

| Variable                  | Notes                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `JWT_SIGNING_KEY`         | HS256 signing key for access tokens.                                   |
| `JWT_SIGNING_KEY_KID`     | Key ID embedded in JWT header. Bump on rotation.                       |
| `JWT_PREVIOUS_KEYS`       | Comma-separated `kid:key` pairs kept valid during rotation.            |
| `SESSION_COOKIE_NAME`     | Defaults to `ws_session`.                                              |
| `SESSION_MAX_AGE_DAYS`    | Cookie lifetime.                                                       |
| `ACCESS_TOKEN_TTL_MIN`    | Access JWT TTL; refresh happens via server-side session row.           |
| `MFA_ENCRYPTION_KEY`      | AES-256 key for TOTP secret-at-rest encryption.                        |
| `COOKIE_SIGNING_KEY`      | HMAC key for signed cookies.                                           |
| `CSRF_SIGNING_KEY`        | HMAC key for double-submit CSRF tokens.                                |
| `ARGON2_MEMORY_KB`        | Password hash memory cost. Don't lower below `65536` in production.    |
| `ARGON2_ITERATIONS`       | Password hash time cost.                                               |
| `ARGON2_PARALLELISM`      | Password hash parallelism.                                             |

## Rate limiting

| Variable                    | Default | Notes                                                                                 |
| --------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `GLOBAL_RATE_LIMIT_PER_MIN` | `600`   | Requests/minute **per identity** (user id if authenticated, client IP otherwise).     |
| `AUTH_RATE_LIMIT_PER_MIN`   | `5`     | Per-IP + per-email login attempts/minute.                                             |
| `LOCKOUT_MAX_FAILURES`      | `5`     | Failed logins before account soft-lock.                                               |
| `LOCKOUT_WINDOW_MIN`        | `15`    | Lock duration.                                                                        |

The global throttler uses a per-user bucket so concurrent operators don't starve each
other. The API trusts a single `X-Forwarded-For` hop (set by the Next.js `web` tier or
an upstream Traefik/Caddy), which is what makes IP-based fallback meaningful inside
Docker — without it every SSR request would share the internal bridge address and
collapse into a single bucket. If you run behind a double-proxy (e.g. Cloudflare →
Traefik → web → api) bump the trust-proxy hop count in `apps/api/src/main.ts`.

## Object storage (MinIO / S3-compatible)

| Variable                    | Notes                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| `MINIO_ENDPOINT`            | Internal hostname the API talks to. `minio` inside compose.             |
| `MINIO_PORT`                | Internal port. `9000` inside compose.                                   |
| `MINIO_USE_SSL`             | `true` if MinIO terminates TLS internally (rare in compose).            |
| `MINIO_REGION`              | Free-form; defaults to `us-east-1`.                                     |
| `MINIO_ACCESS_KEY`          | Root access key — also used by MinIO to init its admin user.            |
| `MINIO_SECRET_KEY`          | Root secret key.                                                        |
| `MINIO_BUCKET_PREFIX`       | Buckets are created as `<prefix>-<tenant>` for isolation.               |
| `MINIO_PUBLIC_URL`          | Origin browsers use for presigned URLs.                                 |
| `NEXT_PUBLIC_MINIO_ORIGINS` | Comma-separated list permitted by the web app's CSP. Usually matches `MINIO_PUBLIC_URL`. |

## Uploads

| Variable                    | Notes                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| `MAX_UPLOAD_MB`             | Server-enforced upload size cap.                                        |
| `NEXT_PUBLIC_MAX_UPLOAD_MB` | Client-side mirror. Keep in sync.                                       |
| `ALLOWED_UPLOAD_MIME`       | Comma-separated MIME allowlist. Add cautiously.                         |

## Logging

| Variable    | Default  | Notes                                          |
| ----------- | -------- | ---------------------------------------------- |
| `LOG_LEVEL` | `info`   | `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |

## Rotating secrets

1. Generate a new value with `keygen.sh` / `keygen.ps1`.
2. For JWT keys, append the **old** key to `JWT_PREVIOUS_KEYS` as
   `<old_kid>:<old_key>` and bump `JWT_SIGNING_KEY_KID`.
3. `docker compose up -d` — api and worker restart; existing sessions
   stay valid until their TTL expires.
4. Remove the old key from `JWT_PREVIOUS_KEYS` after `SESSION_MAX_AGE_DAYS`.

Changing `POSTGRES_PASSWORD` or `REDIS_PASSWORD` requires coordinated
updates to the connection string and to the underlying datastore —
easiest is to do it while stopped (`docker compose down` → edit `.env`
→ wipe the volume if you were just evaluating → `docker compose up -d`).
