# Installing Weavestream

This guide takes you from zero to a running Weavestream instance using
the published Docker images on GitHub Container Registry. You do not
need the source tree, Node.js, or pnpm — just Docker.

## Prerequisites

- **Docker Engine 24+** with Docker Compose v2 (bundled with Docker
  Desktop). Verify with `docker --version` and `docker compose version`.
- **2 GB RAM** free for the full stack (Postgres + Redis + 3
  Weavestream services).
- **A free TCP port** for the web UI (defaults to `3000`). Postgres
  and Redis stay on the internal docker network and are not published
  to the host.

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

## 4. Choose where data lives (optional)

By default Weavestream stores persistent data under `./data/` next to
`compose.yml`. To relocate — e.g. onto a dedicated NAS share — set
`DATA_DIR` in `.env` to an **absolute path**:

```bash
DATA_DIR=/volume1/docker/weavestream     # Synology / UGREEN
DATA_DIR=/srv/weavestream                # plain Linux
```

You don't need to pre-create the folder. Docker auto-creates
`$DATA_DIR/{postgres,redis,files}` on the first `up`, and each
container fixes its own ownership on first boot. Pre-create them
only if you want to lock down permissions ahead of time.

## 5. Start the stack

```bash
docker compose up -d
```

This:

1. Pulls `ghcr.io/weavestream/weavestream-{api,web,worker}:${WEAVESTREAM_VERSION}`
   plus Postgres and Redis.
2. The `api` container runs `prisma migrate deploy` on startup before
   serving traffic. It's idempotent, so re-runs on every `up` are a
   no-op once the schema is current.
3. `worker` and `web` start once `api` reports healthy.

Check status:

```bash
docker compose ps
docker compose logs -f api   # tail API logs
```

The web UI is available at <http://localhost:3000>. The API exposes
two health endpoints:

- `GET /health` — public, liveness only. Returns `{ "status": "ok" }`.
  Safe to scrape from external monitoring; deliberately does not reveal
  the running version or backend topology.
- `GET /health/ready` — authenticated. Probes Postgres + Redis and
  reports the running `WEAVESTREAM_VERSION`. Returns 503 when a
  dependency is down. Reach it from a logged-in admin session.
- `GET /health/queues` — authenticated, requires the `audit.read`
  capability (or `SUPER_ADMIN`). Returns BullMQ counts per lane.

## 6. Create the first admin

```bash
docker compose exec api node dist/cli.js create-admin
```

You'll be prompted for an email and a temporary password. Weavestream
enforces TOTP MFA, so the first login walks you through registering an
authenticator app.

## 7. Set your workspace name

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

The `api` container re-runs `prisma migrate deploy` on every start
and is safe to re-run — it's a no-op when the schema is already
current. Check the [CHANGELOG](../CHANGELOG.md) for any manual
upgrade steps before bumping across minor versions.

## Reverse proxy & TLS

Weavestream does not terminate TLS. Front it with Nginx, Caddy, or
Traefik and forward a single upstream:

| Public path                      | Upstream                              |
| -------------------------------- | ------------------------------------- |
| `https://app.example.com/*`      | `http://<compose-host>:3000`          |

Every thumbnail, attachment, logo, and export PDF is streamed through
the API on the same origin as the web app. That means **one virtual
host is enough** — no separate `files.example.com` to set up, and the
underlying file store stays on the container's bind-mounted directory
without any network surface of its own.

Update the following in `.env` to match your public origin before
restarting so cookies and links point at the right hostname:

- `APP_URL` — public web origin (`https://app.example.com`).
- `API_URL` — public API origin (`https://app.example.com/api`).

Make sure your reverse proxy:

- Terminates TLS and only forwards to the upstream above.
- Sets `X-Forwarded-Proto: https` and overwrites (does not append to)
  `X-Forwarded-For` so the API audit trail records the real client IP
  rather than a value the client supplied.

## Backups

Persistent data lives in real host folders under `$DATA_DIR`
(default: `./data` next to `compose.yml`). Override `DATA_DIR` in
`.env` to relocate — e.g. `DATA_DIR=/volume1/docker/weavestream` on a
Synology/UGREEN NAS.

| Folder               | Purpose                                | Back up? |
| -------------------- | -------------------------------------- | -------- |
| `$DATA_DIR/postgres` | Postgres data dir                      | **Yes**  |
| `$DATA_DIR/files`    | Uploaded images, attachments, exports  | **Yes**  |
| `$DATA_DIR/redis`    | Cache + BullMQ queue (replayable)      | Optional |

A simple nightly routine:

```bash
# Postgres dump (recommended — always point-in-time consistent)
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "backup-$(date +%F).sql.gz"

# Files — straight rsync of the host directory (safe while running;
# the api/worker write atomically via tmp+rename so partial files
# never appear in the destination).
rsync -a "$DATA_DIR/files/" "/backup/files-$(date +%F)/"
```

### `audit_log` immutability

The `audit_log` table is append-only at the database level: a
`BEFORE UPDATE OR DELETE` trigger (`audit_log_no_update_delete`,
installed by migration `0032_audit_log_immutable`) rejects any
non-INSERT write with `audit_log is append-only`. `pg_dump` /
`pg_restore` are unaffected because both rely on `COPY` and `TRUNCATE`,
neither of which fires per-row triggers.

Operators who legitimately need to rewrite audit rows — for example to
anonymise audit data before sharing a dump — can disable the trigger
as the table owner:

```bash
docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB" <<'SQL'
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete;
-- ... UPDATE / DELETE statements here ...
ALTER TABLE audit_log ENABLE TRIGGER  audit_log_no_update_delete;
SQL
```

Non-superuser application credentials (the role configured in
`DATABASE_URL`) cannot disable the trigger, so a compromised API
process cannot quietly rewrite audit history.

## Troubleshooting

| Symptom                                          | Check                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `api` fails at startup with `P1000` or `P1001`   | Migration step can't reach Postgres. Check `DATABASE_URL` and `docker compose logs postgres`. |
| Web UI loads but API calls 502                   | `api` probably unhealthy; `docker compose logs api`. Confirm Redis password matches. |
| Image uploads fail with CORS / CSP errors        | Browser-facing reads stream through the API on the web origin — confirm `APP_URL` matches the hostname you load in the browser. |
| Login says "Invalid credentials" after reset     | `POSTGRES_PASSWORD` changed but `DATABASE_URL` still points at the old password.  |

Still stuck? Open a [GitHub Discussion](https://github.com/Weavestream/Weavestream/discussions)
or a [bug report](https://github.com/Weavestream/Weavestream/issues/new/choose).
