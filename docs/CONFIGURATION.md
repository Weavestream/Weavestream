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

| Variable        | Default | Published      | Service                                          |
| --------------- | ------- | -------------- | ------------------------------------------------ |
| `WEB_HOST_PORT` | `3000`  | All interfaces | Next.js UI. Front this with HTTPS in production. |

### Browsers never fetch the storage layer directly

Every thumbnail, attachment, logo, and export PDF is streamed through
the API on the same origin as the web app
(`/api/v1/companies/:id/uploads/:upload/image`,
`/api/v1/export/job/:id/download`, etc.). One reverse-proxy entry
covers the whole app — there is **no second `files.example.com`
virtual host** to set up, and the underlying file directory has no
network surface of its own.

Postgres and Redis are not published to the host. Operators inspect
them with `docker compose exec postgres psql ...` and
`docker compose exec redis redis-cli ...`. Contributors who run
`pnpm dev` against the compose stack layer
[`compose.build.yml`](../compose.build.yml), which re-publishes the
classic dev ports (`5434` Postgres, `6381` Redis).

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
other. IP-based fallback (rate limiting, login lockouts, audit attribution) reads
`req.ip` only — never the raw `X-Forwarded-For` header — so the API only ever sees an
IP that survived Express's `trust proxy` validation. See **Client IP attribution**
below for how to configure the proxy depth.

## Client IP attribution

| Variable             | Default | Notes                                                                |
| -------------------- | ------- | -------------------------------------------------------------------- |
| `TRUST_PROXY_HOPS`   | `1`     | Number of trusted reverse-proxy hops between the client and the API. |

Express resolves `req.ip` to the `(N+1)`th entry from the right of the verified
`X-Forwarded-For` chain, where `N` is `TRUST_PROXY_HOPS`. Match this to your actual
topology:

| Topology                                             | `TRUST_PROXY_HOPS` |
| ---------------------------------------------------- | ------------------ |
| `compose.yml` default (`web` Next.js → `api`)        | `1`                |
| Edge proxy (Caddy / Traefik / Nginx) → `web` → `api` | `2`                |
| CDN (e.g. Cloudflare) → edge → `web` → `api`         | `3`                |

The reverse proxy at every hop **must** overwrite or append to `X-Forwarded-For`
(never blindly trust the value the client supplied) and should set
`X-Forwarded-Proto` so `req.secure` is correct. Setting `TRUST_PROXY_HOPS` too high
lets a malicious upstream forge the client IP; setting it too low collapses every
request behind a proxy into one bucket — the original cause of the 429-as-404
flake we hit in compose.

## Egress / SSRF guard

Every server-side outbound HTTP request flows through `safeFetch`, which
resolves the target hostname and refuses to dial loopback, RFC1918,
link-local, multicast, or cloud-metadata (`169.254.169.254`) addresses.
This blocks the standard SSRF playbook — operator paste of
`http://localhost`, `http://169.254.169.254` for AWS / GCP / Azure
metadata, `http://10.x.x.x` to enumerate internal services — and applies
to integration drivers, RDAP / WHOIS bootstrap, the WEBSITE_DOWN HTTP
probe, and the HIBP password-leak check.

| Variable                        | Default | Notes                                                                 |
| ------------------------------- | ------- | --------------------------------------------------------------------- |
| `EGRESS_ALLOW_PRIVATE_NETWORKS` | `false` | Set to `true` to disable the entire blocklist. Lab / single-host only. |
| `EGRESS_ALLOWED_PRIVATE_CIDRS`  | _empty_ | Comma-separated CIDRs allowed even when the blocklist is on.           |

**Operator playbook**

- **You don't need either knob** for normal cloud-hosted deployments —
  every legitimate target (HIBP, RDAP, IANA, customer SaaS endpoints)
  resolves to a public IP and goes through unchanged.
- **On-prem RMM endpoints** (e.g. an internal Action1 / UniFi instance):
  add the network to `EGRESS_ALLOWED_PRIVATE_CIDRS`, e.g.
  `EGRESS_ALLOWED_PRIVATE_CIDRS=10.42.0.0/16`. Other private addresses
  remain blocked.
- **All-private network** (offline lab, air-gapped install): set
  `EGRESS_ALLOW_PRIVATE_NETWORKS=true`. Every refusal is still audit-
  logged, but the guard becomes an observation tool only.

Each refusal is recorded as `security.egress.blocked` and surfaced in
**Admin → Security → Egress blocks** with the URL, hostname, resolved
IPs, reason, and matched CIDR.

## File storage

Uploaded files (attachments, thumbnails, logos, export PDFs) live on
the local filesystem under a single host-bind-mounted directory.
Tenant isolation is by directory:

```text
${FILE_STORAGE_DIR}/<companyId>/uploads/<uploadId>/<filename>
${FILE_STORAGE_DIR}/<companyId>/thumbs/<uploadId>.webp
${FILE_STORAGE_DIR}/<companyId>/exports/<exportId>.pdf
```

| Variable           | Default          | Notes                                                                                                                                                                                  |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`         | `./data`         | Host-side data root. Uploaded files live at `${DATA_DIR}/files`, alongside `${DATA_DIR}/postgres` and `${DATA_DIR}/redis`.                                                              |
| `FILE_STORAGE_DIR` | `./data/files`   | Storage root. Defaults to a path under `DATA_DIR`. compose.yml bind-mounts `${DATA_DIR}/files` into api+worker and sets `FILE_STORAGE_DIR` for you, so leave this unset for compose. |

The api/worker write atomically (write to `<key>.tmp-<random>`, then
`fs.rename`), so an `rsync` of the host directory while the stack is
running never sees partial files. There is no S3 surface, no admin
console, and no extra credentials to manage.

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
