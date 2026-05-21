---
label: Backup & Restore
icon: database
order: 600
description: Protect Weavestream data with scheduled exports, off-host file backups, and tested restore procedures.
---

# Backup & Restore

This guide explains how to protect a Weavestream deployment and restore it after a host failure.

Weavestream stores persistent data under `$DATA_DIR` (default: `./data` next to `compose.yml`). A complete backup needs both database data and filesystem data.

## What To Back Up

| Location | Contents | Required for restore |
|---|---|---|
| `$DATA_DIR/postgres` | Live PostgreSQL data directory | Yes, or use a logical dump from `$DATA_DIR/backup` |
| `$DATA_DIR/files` | Uploads, attachments, logos, thumbnails, export PDFs | Yes |
| `$DATA_DIR/backup` | Scheduled `pg_dump --format=custom` files and manifests | Yes, if using in-app backups |
| `$DATA_DIR/redis` | Sessions, queues, cache | No, normally replayable |
| `.env` | Signing keys, encryption keys, database passwords, Redis passwords | Yes |

Redis data is usually replayable: queued jobs can retry, sessions can expire, and users can log in again. Postgres, uploaded files, backup dumps, and `.env` secrets are the irreplaceable pieces.

!!!warning
The scheduled backup dump is not encrypted by Weavestream. Store `$DATA_DIR/backup` on encrypted storage or replicate it with an encrypted tool such as restic, borg, or rclone crypt. Back up `.env` separately in a secrets vault.
!!!

## Confirm Your Data Directory

By default, `compose.yml` stores data in `./data` next to the compose file. If you set `DATA_DIR` in `.env`, use that path instead.

```bash
cd /opt/weavestream
grep '^DATA_DIR=' .env || echo "DATA_DIR=./data"
```

For the examples below:

```bash
COMPOSE_DIR=/opt/weavestream
DATA_DIR=$COMPOSE_DIR/data
```

If your `.env` uses a custom `DATA_DIR`, replace the value above.

## In-App Scheduled Postgres Export

Operators with the `BACKUP_MANAGE` capability, or any `SUPER_ADMIN`, can configure scheduled Postgres exports under **Admin -> Backups**. Each schedule produces:

```text
$DATA_DIR/backup/weavestream-postgres-<timestamp>.dump
$DATA_DIR/backup/weavestream-postgres-<timestamp>.manifest.json
```

The dump is a portable `pg_dump --format=custom` export. The manifest includes the dump filename, SHA-256 checksum, Weavestream version, Prisma migration hash, database hostname, generated timestamp, and active password-encryption key id.

### Configure A Schedule

1. Go to **Admin -> Backups**.
2. Click **New schedule**.
3. Pick a cron preset or enter a five-field cron expression.
4. Set the timezone, for example `Etc/UTC` or `America/New_York`.
5. Set retention:
   - **Keep last** keeps the N most-recent successful runs regardless of date bucket. Default: `3`.
   - **Daily** keeps one run per distinct day.
   - **Weekly** keeps one run per ISO week.
   - **Monthly** keeps one run per calendar month.
6. Optional: add notification email addresses.
7. Save the schedule.

Click **Run now** once and wait for a successful run before relying on the schedule.

### Run-Now And Downloads

The History tab shows each run and exposes:

- **Download** - streams the dump back through the API. The API container has the backup directory mounted read-only for this path.
- **Manifest** - opens the JSON sidecar with version, migration, encryption key id, checksum, and dump metadata.

### Concurrency Safety

Every run takes a Postgres advisory lock around the whole job. If a second run starts while another is in flight, it is marked `failed` with `error = 'concurrent'` instead of racing.

### What's In The Dump

The exported dump contains every Weavestream table. It does **not** contain:

- `$DATA_DIR/files`. Uploaded attachments live on the filesystem, not in Postgres.
- `.env` secrets. The `PASSWORD_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `JWT_SIGNING_KEY`, and related keys are required to decrypt and authenticate restored data.

## Back Up Files And Dumps Off-Host

The in-app backup only exports PostgreSQL. You must also copy uploaded files and secrets off the Docker host.

Minimum off-host backup set:

```text
$DATA_DIR/backup/
$DATA_DIR/files/
.env
```

Recommended nightly sync:

```bash
#!/bin/bash
set -euo pipefail

COMPOSE_DIR=/opt/weavestream
DATA_DIR="$COMPOSE_DIR/data"
DEST=/mnt/backups/weavestream
DATE=$(date +%F)

mkdir -p "$DEST/postgres-dumps" "$DEST/files-$DATE" "$DEST/secrets"

# Database dumps produced by Admin -> Backups.
rsync -a "$DATA_DIR/backup/" "$DEST/postgres-dumps/"

# Uploaded files and generated file artifacts.
rsync -a "$DATA_DIR/files/" "$DEST/files-$DATE/"

# Secrets required to decrypt vaulted data after restore.
cp "$COMPOSE_DIR/.env" "$DEST/secrets/.env"

# Example file snapshot rotation. The database dumps are pruned by
# Weavestream retention, so this only rotates file snapshots.
find "$DEST" -maxdepth 1 -type d -name 'files-*' -mtime +30 -exec rm -rf {} +
```

For production, run this from cron or a systemd timer and replicate `DEST` to a different machine, NAS, or encrypted object storage.

Example with restic:

```bash
restic -r s3:https://s3.amazonaws.com/example-weavestream-backups backup \
  "$DATA_DIR/backup" \
  "$DATA_DIR/files" \
  "$COMPOSE_DIR/.env"
```

The in-app dumps are bit-for-bit identical to a manual `pg_dump --format=custom`, so they deduplicate well across nightly snapshots in tools such as restic and rclone.

## Optional Manual Database Dumps

Even with the in-app schedule enabled, you may want a one-off logical dump before upgrades or maintenance.

```bash
cd /opt/weavestream
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" --format=custom --no-owner --no-acl "$POSTGRES_DB" \
  > "weavestream-postgres-manual-$(date -u +%Y-%m-%dT%H-%M-%SZ).dump"
```

This does not replace `$DATA_DIR/files` or `.env`.

For very large deployments, you can also take a physical copy of the Postgres data directory while Postgres is stopped:

```bash
docker compose stop postgres
rsync -a "$DATA_DIR/postgres/" /backup/postgres/
docker compose start postgres
```

## Restore On A New Docker Host

Use this when the original Docker host is gone and you have:

- A Weavestream `.dump` file from `$DATA_DIR/backup`.
- A matching `$DATA_DIR/files` backup.
- The original `.env`.

### Prepare The New Host

```bash
mkdir -p /opt/weavestream
cd /opt/weavestream

curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/compose.yml
cp /backup/weavestream/secrets/.env .env

mkdir -p data
rsync -a /backup/weavestream/files-2026-05-01/ data/files/
```

If your original `.env` set `DATA_DIR`, recreate that directory and restore files there instead.

### Start PostgreSQL Only

```bash
docker compose up -d postgres
docker compose ps postgres
```

Wait until the container is healthy.

### Restore The Database Dump

Replace the dump path with the file you want to restore:

```bash
docker compose exec -T postgres sh -lc \
  'pg_restore --clean --if-exists --no-owner --no-acl \
     -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < /backup/weavestream/postgres-dumps/weavestream-postgres-2026-05-01T03-00-00Z.dump
```

If the database already contains partial data and the restore fails, recreate it and retry:

```bash
docker compose exec -T postgres sh -lc \
  'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" &&
   createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

Then run the `pg_restore` command again.

### Start The Full Stack

```bash
docker compose up -d
docker compose ps
```

The `api` container runs `prisma migrate deploy` on boot. If the restored dump already includes all migrations, this is a no-op.

## Restore Uploaded Files Later

If you restored the database first and need to restore files afterward:

```bash
cd /opt/weavestream
docker compose stop api worker
rsync -a /backup/weavestream/files-2026-05-01/ data/files/
docker compose start api worker
```

## Restore From A Legacy SQL Dump

If you used an older `pg_dump | gzip` routine and have a `.sql.gz` file, restore it with `psql` instead of `pg_restore`:

```bash
# Stop the api, web, and worker but keep postgres running.
docker compose stop api web worker

# Drop and recreate the database.
docker compose exec -T postgres \
  psql -U postgres -c "DROP DATABASE weavestream; CREATE DATABASE weavestream OWNER weavestream;"

# Restore.
gunzip -c backup-2026-05-01.sql.gz | \
  docker compose exec -T postgres psql -U weavestream weavestream

# Start everything again.
docker compose up -d
```

## Verify The Restore

After the stack starts:

1. Sign in with an existing admin account.
2. Open a saved password and confirm it decrypts. This proves the restored `.env` has the correct `PASSWORD_ENCRYPTION_KEY`.
3. Open an uploaded image or attachment. This proves `$DATA_DIR/files` is restored.
4. Go to **Admin -> Backups** and confirm history is visible.
5. Click **Run now** and confirm a new dump is written to `$DATA_DIR/backup`.

## Troubleshooting

### `pg_restore: error: input file appears to be a text format dump`

The restore command above expects Weavestream's in-app custom-format dump. If you have a `.sql` or `.sql.gz` dump, restore it with `psql` instead:

```bash
gunzip -c backup.sql.gz | docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

### Passwords Or Secrets Do Not Decrypt

The database restored, but `.env` does not match the original deployment. Restore the original values for:

```text
PASSWORD_ENCRYPTION_KEY
PASSWORD_PREVIOUS_KEYS
MFA_ENCRYPTION_KEY
INTEGRATION_SECRET_KEY
SMTP_SECRET_KEY
JWT_SIGNING_KEY
```

If these keys are lost, encrypted vault values cannot be recovered from the database dump.

### Attachments Are Missing

The database references files that are not present under `$DATA_DIR/files`. Restore the file backup again and confirm ownership and permissions allow the api container to read the directory.

### Backup Runs Keep Only One Dump Per Day

Increase **Keep last** in the backup schedule. Daily, weekly, and monthly retention is bucketed, so multiple manual runs in the same day count as one daily slot unless protected by **Keep last**.

## Checklist

- [ ] At least one scheduled backup exists under **Admin -> Backups**.
- [ ] A manual **Run now** backup has succeeded.
- [ ] `$DATA_DIR/backup` is copied off-host.
- [ ] `$DATA_DIR/files` is copied off-host.
- [ ] `.env` is stored securely outside the Docker host.
- [ ] Off-host backups are encrypted.
- [ ] Retention is configured in Weavestream and in the off-host backup system.
- [ ] A restore has been tested on a clean host.
