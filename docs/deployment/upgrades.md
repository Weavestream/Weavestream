---
label: Upgrades
icon: arrow-up
order: 700
description: How to safely upgrade Weavestream to a new version.
---

# Upgrades

Weavestream uses semantic versioning. Check the [changelog](/overview/changelog/) before upgrading across minor versions — some releases include manual migration steps.

## Standard Upgrade (Patch Releases)

For patch releases (e.g. `1.1.0` → `1.1.1`) with no manual steps in the changelog:

```bash
# 1. Update the version pin in .env
sed -i '' 's/^WEAVESTREAM_VERSION=.*/WEAVESTREAM_VERSION=1.1.1/' .env
# On Linux (GNU sed):
# sed -i 's/^WEAVESTREAM_VERSION=.*/WEAVESTREAM_VERSION=1.1.1/' .env

# 2. Pull new images
docker compose pull

# 3. Restart with the new images
docker compose up -d
```

The `api` container runs `prisma migrate deploy` automatically on startup. Schema migrations are idempotent — re-running on an already-current schema is a no-op.

## Minor Version Upgrades

Check the [changelog](/overview/changelog/) for any `### Upgrading from X.Y.Z` sections. These describe manual steps that must be completed **before** or **alongside** the image update.

### Example: 1.0.0 → 1.1.0

The 1.1.0 release introduced:

1. New required environment variables (`PASSWORD_ENCRYPTION_KEY`, `PASSWORD_ENCRYPTION_KEY_KID`)
2. A change from named Docker volumes to bind-mounted host folders

Before pulling new images:

```bash
# 1. Stop the stack
docker compose down

# 2. Migrate data from named volumes to bind-mount folders
mkdir -p ./data/postgres ./data/redis ./data/minio

docker run --rm -v weavestream_pg_data:/src -v "$PWD/data/postgres":/dst \
  alpine sh -c 'cp -a /src/. /dst/'
docker run --rm -v weavestream_redis_data:/src -v "$PWD/data/redis":/dst \
  alpine sh -c 'cp -a /src/. /dst/'
docker run --rm -v weavestream_minio_data:/src -v "$PWD/data/minio":/dst \
  alpine sh -c 'cp -a /src/. /dst/'

# 3. Remove old named volumes
docker volume rm weavestream_pg_data weavestream_redis_data weavestream_minio_data

# 4. Update compose.yml and .env from the v1.1.0 tag
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/v1.1.0/compose.yml

# 5. Add new env vars
./scripts/keygen.sh | grep PASSWORD_ENCRYPTION_KEY >> .env
echo 'PASSWORD_ENCRYPTION_KEY_KID=2026-01' >> .env

# 6. Start the updated stack
docker compose up -d
```

## Rolling Back

If something goes wrong after an upgrade, roll back by pinning to the previous version:

```bash
docker compose down
# Edit .env: set WEAVESTREAM_VERSION back to the old version
docker compose up -d
```

!!!warning Schema rollbacks
Rolling back is safe as long as you haven't run new Prisma migrations yet. If the `api` container started and applied migrations before you noticed the problem, rolling back the image does not roll back the schema. Restore from a database backup in that case.
!!!

## Backup Before Upgrading

Always take a database backup before upgrading across minor versions:

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "pre-upgrade-$(date +%F).sql.gz"
```

See [Backup & Restore](/deployment/backup/) for a complete backup strategy.

## Upgrade Checklist

- [ ] Read the [changelog](/overview/changelog/) for the target version
- [ ] Take a database backup
- [ ] Complete any manual steps from the changelog
- [ ] Re-download `compose.yml` from the target release tag (if instructed)
- [ ] Update `WEAVESTREAM_VERSION` in `.env`
- [ ] `docker compose pull`
- [ ] `docker compose up -d`
- [ ] Verify all containers are healthy: `docker compose ps`
- [ ] Check the API health endpoint: `curl http://localhost:3000/api/health`
