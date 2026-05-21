---
label: Docker Compose
icon: container
order: 900
description: Production Docker Compose deployment walkthrough.
---

# Docker Compose

The canonical way to deploy Weavestream is with the published `compose.yml`. This guide covers a production-grade setup.

## The compose.yml

The compose file defines five services:

```yaml
services:
  postgres:   # PostgreSQL 16 — primary database
  redis:      # Redis 7 — sessions, queues, cache
  api:        # NestJS REST API
  web:        # Next.js frontend
  worker:     # BullMQ background jobs
```

Uploaded files (attachments, thumbnails, logos, export PDFs) live on a host bind-mounted directory (`${DATA_DIR}/files`) shared by `api` and `worker`. No additional storage container is required.

All Weavestream images are pulled from GitHub Container Registry:
```
ghcr.io/weavestream/weavestream-{api,web,worker}:<version>
```

## Production Setup

### 1. Download compose.yml and .env

Pin to a specific release tag:

```bash
mkdir weavestream && cd weavestream
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/v1.1.1/compose.yml
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/v1.1.1/.env.example
mv .env.example .env
```

### 2. Generate secrets

```bash
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/v1.1.1/scripts/keygen.sh
chmod +x keygen.sh
./keygen.sh >> .env
```

Update `DATABASE_URL` and `REDIS_URL` to use the newly generated passwords.

### 3. Set critical variables in .env

```bash
WEAVESTREAM_VERSION=1.1.1
APP_URL=https://your-domain.com
API_URL=https://your-domain.com/api
DATA_DIR=/opt/weavestream/data   # or your preferred path
```

### 4. Configure data directory

```bash
mkdir -p /opt/weavestream/data/{postgres,redis,files}
```

Or let Docker create it automatically on first boot.

### 5. Start the stack

```bash
docker compose up -d
```

### 6. Create the first admin

```bash
docker compose exec api node dist/cli.js create-admin
```

## Health Checks

Each service has a health check defined in `compose.yml`. Check the status:

```bash
docker compose ps
```

The `web` and `worker` services wait for `api` to be healthy before starting. The `api` service runs `prisma migrate deploy` on boot — this takes a few seconds on first run.

The API exposes three health endpoints:

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /health` | Public | Liveness only. Returns `{ "status": "ok" }` and intentionally exposes no version or backend diagnostics. |
| `GET /health/ready` | Authenticated | Readiness check for Postgres and Redis, plus the running Weavestream version. |
| `GET /health/queues` | Authenticated, requires `AUDIT_READ` | BullMQ queue counts for background job lanes. |

## Useful Commands

```bash
# View logs
docker compose logs -f api
docker compose logs -f worker

# Check API health
curl http://localhost:3000/api/health

# Run CLI commands
docker compose exec api node dist/cli.js --help

# Restart a single service
docker compose restart api

# Stop everything
docker compose down

# Stop and remove volumes (destructive — data loss!)
docker compose down -v
```

## Scaling

`api` and `worker` are stateless and can be scaled horizontally:

```bash
docker compose up -d --scale api=3 --scale worker=2
```

`prisma migrate deploy` uses a Postgres advisory lock, so multiple `api` replicas are safe to start simultaneously.

## Environment Variables at Runtime

Environment variables in `.env` are loaded by Docker Compose and injected into each container. To apply a change:

```bash
# Edit .env
docker compose up -d   # containers restart with new env
```

Some changes (like `DATA_DIR`) require the stack to be stopped first to avoid data loss.

## Troubleshooting

| Symptom | Check |
|---|---|
| `api` fails at startup with `P1000` or `P1001` | Migration step cannot reach Postgres. Check `DATABASE_URL` and `docker compose logs postgres`. |
| Web UI loads but API calls return 502 | `api` is probably unhealthy. Run `docker compose logs api` and confirm the Redis password matches `REDIS_URL`. |
| Image uploads fail with CORS or CSP errors | Browser-facing reads stream through the API on the web origin. Confirm `APP_URL` matches the hostname you load in the browser. |
| Login says "Invalid credentials" after a reset | `POSTGRES_PASSWORD` changed but `DATABASE_URL` still points at the old password. |
