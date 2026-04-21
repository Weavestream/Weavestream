# Installing Weavestream

This guide takes you from zero to a running Weavestream instance using
the published Docker images on GitHub Container Registry. You do not
need the source tree, Node.js, or pnpm — just Docker.

## Prerequisites

- **Docker Engine 24+** with Docker Compose v2 (bundled with Docker
  Desktop). Verify with `docker --version` and `docker compose version`.
- **2 GB RAM** free for the full stack (Postgres + Redis + MinIO + 3
  Weavestream services).
- **A free TCP port** for the web UI (defaults to `3000`) and for
  MinIO's S3 API + console (defaults to `9100` and `9101`).

## 1. Download the two files you need

```bash
mkdir weavestream && cd weavestream
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/compose.yml
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/.env.example
mv .env.example .env
```

You can also download these from a specific release tag — replace
`main` with `v1.0.0` (or whatever you plan to pin to).

## 2. Generate random secrets

### macOS / Linux / WSL

```bash
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/scripts/keygen.sh
chmod +x keygen.sh
./keygen.sh >> .env
```

### Windows (PowerShell 5.1+ / PowerShell 7+)

```powershell
Invoke-WebRequest `
  -Uri https://raw.githubusercontent.com/Weavestream/Weavestream/main/scripts/keygen.ps1 `
  -OutFile keygen.ps1
.\keygen.ps1 | Out-File -Append -Encoding ascii .env
```

Open `.env` in a text editor and delete the `REPLACEME` rows at the top
— the `keygen` output at the bottom supersedes them. Then update
`DATABASE_URL` and `REDIS_URL` to contain the new `POSTGRES_PASSWORD`
and `REDIS_PASSWORD` respectively.

## 3. Pin a version (recommended)

Edit `.env` and set a specific release tag:

```bash
WEAVESTREAM_VERSION=1.0.0
```

Browse published tags at <https://github.com/Weavestream/Weavestream/pkgs/container/weavestream-api>.
Using `latest` is fine for evaluation but can surface breaking changes
without warning.

## 4. Start the stack

```bash
docker compose up -d
```

This:

1. Pulls `ghcr.io/weavestream/weavestream-{api,web,worker}:${WEAVESTREAM_VERSION}`
   plus Postgres, Redis, and MinIO.
2. Runs the one-shot `migrate` service (`prisma migrate deploy`). It
   exits `0` when the schema is up to date.
3. Starts `api`, `worker`, and `web` once `migrate` is done and the
   datastores report healthy.

Check status:

```bash
docker compose ps
docker compose logs -f api   # tail API logs
```

The web UI is available at <http://localhost:3000>. The API's
`/health` endpoint reports the running version.

## 5. Create the first admin

```bash
docker compose exec api node dist/cli.js create-admin
```

You'll be prompted for an email and a temporary password. Weavestream
enforces TOTP MFA, so the first login walks you through registering an
authenticator app.

## 6. Set your workspace name

Sign in as `SUPER_ADMIN` and visit **Admin → Settings** to set your
workspace name and choose the term you want to use for tenants
(companies, clients, departments, etc.). Defaults are chosen so a fresh
install never shows brand-specific copy.

## Upgrading

```bash
# Bump the pin
sed -i '' 's/^WEAVESTREAM_VERSION=.*/WEAVESTREAM_VERSION=1.1.0/' .env
# or edit .env manually on Windows

docker compose pull
docker compose up -d
```

The `migrate` service runs automatically on every `up` and is safe to
re-run — it's a no-op when the schema is already current. Check the
[CHANGELOG](../CHANGELOG.md) for any manual upgrade steps before
bumping across minor versions.

## Reverse proxy & TLS

Weavestream does not terminate TLS. Front it with Nginx, Caddy, or
Traefik and forward to `http://<compose-host>:3000`. Update `APP_URL`,
`API_URL`, `MINIO_PUBLIC_URL`, and `NEXT_PUBLIC_MINIO_ORIGINS` in `.env`
to the public HTTPS origins before restarting so cookies, CSP, and
presigned URLs point at the right hostname.

## Backups

Two volumes hold state you care about:

- `pg_data` — Postgres
- `minio_data` — object storage (uploaded images, attachments)

Redis data (`redis_data`) is a cache/queue backing store; BullMQ jobs
are replayable, so snapshotting is optional.

A simple nightly routine:

```bash
# Postgres dump
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "backup-$(date +%F).sql.gz"

# MinIO mirror (run from anywhere with mc installed)
mc mirror myalias/weavestream-* ./minio-backup/
```

## Troubleshooting

| Symptom                                          | Check                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `migrate` service fails with `P1000` or `P1001`  | Wrong `DATABASE_URL` or Postgres not healthy yet. Check `docker compose logs postgres`. |
| Web UI loads but API calls 502                   | `api` probably unhealthy; `docker compose logs api`. Confirm Redis password matches. |
| Image uploads fail with CORS / CSP errors        | `NEXT_PUBLIC_MINIO_ORIGINS` must include the hostname your browser actually uses. |
| Login says "Invalid credentials" after reset     | `POSTGRES_PASSWORD` changed but `DATABASE_URL` still points at the old password.  |

Still stuck? Open a [GitHub Discussion](https://github.com/Weavestream/Weavestream/discussions)
or a [bug report](https://github.com/Weavestream/Weavestream/issues/new/choose).
