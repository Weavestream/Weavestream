---
label: Quickstart
icon: zap
order: 900
description: Deploy Weavestream with Docker Compose in under 10 minutes.
---

# Quickstart

This guide takes you from zero to a running Weavestream instance.

## Step 1 — Download the two files you need

```bash
mkdir weavestream && cd weavestream
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/compose.yml
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/.env.example
mv .env.example .env
```

You can pin to a specific release tag by replacing `main` with `v1.1.1` (or your target version).

## Step 2 — Generate random secrets

### macOS / Linux / WSL

```bash
curl -O https://raw.githubusercontent.com/Weavestream/Weavestream/main/scripts/keygen.sh
chmod +x keygen.sh
./keygen.sh >> .env
```

### Windows (PowerShell)

```powershell
Invoke-WebRequest `
  -Uri https://raw.githubusercontent.com/Weavestream/Weavestream/main/scripts/keygen.ps1 `
  -OutFile keygen.ps1
.\keygen.ps1 | Out-File -Append -Encoding ascii .env
```

Open `.env` in a text editor and delete the `REPLACEME` placeholder rows — the keygen output appended at the bottom supersedes them. Then update `DATABASE_URL` and `REDIS_URL` to use the newly generated `POSTGRES_PASSWORD` and `REDIS_PASSWORD` values.

!!!Many built-in NAS editors hide files starting with a dot. If you need to make changes, rename the file to env.txt, edit your settings, and then rename it back to .env when finished.
!!!

## Step 3 — Pin a version (recommended)

Edit `.env` and set a specific release:

```bash
WEAVESTREAM_VERSION=1.1.1
```

Using `latest` is fine for evaluation but can surface breaking changes without warning. Browse published tags at [GitHub Container Registry](https://github.com/Weavestream/Weavestream/pkgs/container/weavestream-api).

## Step 4 — Choose where data lives (optional)

By default, persistent data is stored in `./data/` next to `compose.yml`. To use a different location (e.g. a NAS share), set `DATA_DIR` in `.env`:

```bash
DATA_DIR=/volume1/docker/weavestream   # Synology / UGREEN
DATA_DIR=/srv/weavestream               # plain Linux
```

Docker auto-creates `$DATA_DIR/{postgres,redis,files}` on first boot.

## Step 5 — Start the stack

```bash
docker compose up -d
```

This pulls all images and starts the containers. The `api` container runs `prisma migrate deploy` automatically before serving traffic.

Check status:

```bash
docker compose ps
docker compose logs -f api
```

The web UI is available at [http://localhost:3000](http://localhost:3000).

## Step 6 — Create the first admin

```bash
docker compose exec [your-api-container-name] node dist/cli.js create-admin
```

You will be prompted for an email address and a temporary password.

## What's next?

- [First Login](/getting-started/first-login/) — complete MFA setup and configure your workspace
- [Invite Users](/getting-started/invite-users/) — add operators and client users
- [Configuration Reference](/configuration/environment/) — review all environment variables

!!!warning Pin your version before going to production
Never run `:latest` in production. Set `WEAVESTREAM_VERSION` in `.env` to a specific release tag so upgrades are deliberate. See the [upgrade guide](/deployment/upgrades/).
!!!
