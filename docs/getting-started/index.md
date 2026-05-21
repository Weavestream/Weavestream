---
label: Getting Started
icon: rocket
order: 700
description: Prerequisites and overview for deploying Weavestream.
---

# Getting Started

Weavestream is designed for a fast, friction-free deployment. You do not need the source tree, Node.js, or pnpm — just Docker and two files.

## Prerequisites

| Requirement | Minimum version |
|---|---|
| Docker Engine | 24+ |
| Docker Compose | v2 (bundled with Docker Desktop) |
| RAM | 2 GB free for the full stack |
| Disk | ~500 MB for images + your data |

Verify your setup:

```bash
docker --version
docker compose version
```

## What You're Deploying

The stack consists of five containers:

| Container | Role |
|---|---|
| `web` | Next.js frontend (admin UI + client portals) |
| `api` | NestJS REST API |
| `worker` | Background jobs (domain checks, thumbnails, search indexing) |
| `postgres` | Primary database |
| `redis` | Session store, queues, cache |

Uploaded files (attachments, thumbnails, logos, exports) live on a host bind-mounted directory (`${DATA_DIR}/files`) shared by `api` and `worker`. No additional storage container is required.

All images are published to GitHub Container Registry (`ghcr.io/weavestream/weavestream-*`). No build step required.

## Installation Steps

1. [Quickstart](/getting-started/quickstart/) — download, configure, and start in under 10 minutes
2. [First login](/getting-started/first-login/) — set up your admin account, MFA, and workspace name
3. [Invite users](/getting-started/invite-users/) — add your first operators and client users

## Platform Notes

### NAS (Synology, UGREEN, TrueNAS)

Set `DATA_DIR` in `.env` to an absolute path on your NAS volume:

```bash
DATA_DIR=/volume1/docker/weavestream
```

Docker auto-creates the subdirectories on first boot.

### Windows

Use `scripts/keygen.ps1` (PowerShell 5.1+) instead of `keygen.sh` for secret generation. Docker Desktop with WSL2 is the recommended runtime.

### Raspberry Pi / ARM

All images are published as multi-arch (`linux/amd64` + `linux/arm64`). No separate ARM images are needed.
