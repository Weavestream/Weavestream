---
label: Deployment
icon: server
order: 400
description: Production deployment, TLS, upgrades, and backup strategy.
---

# Deployment

Weavestream is designed for self-hosted deployment using Docker Compose. This section covers everything you need to run it reliably in production.

## Deployment Guides

- [Docker Compose](/deployment/docker-compose/) — production Docker Compose walkthrough
- [TLS & Reverse Proxy](/deployment/tls/) — configure HTTPS with Nginx, Caddy, or Traefik
- [Upgrades](/deployment/upgrades/) — how to update to a new version safely
- [Backup & Restore](/deployment/backup/) — protecting your data

## Architecture Summary

```
Internet → Reverse Proxy (Nginx/Caddy/Traefik) → web:3000 → api:4000
                                                            ↓
                                                       postgres / redis
                                                            │
                                              (api & worker share a
                                               host bind-mounted dir
                                               for uploaded files)
```

Weavestream does not terminate TLS itself. A reverse proxy handles HTTPS and forwards to the Next.js `web` container on port 3000. **Exposing the `web` port (3000) directly to the internet is for local/LAN use only** — without a trusted proxy in front, client IP attribution for audit logs, lockout, rate limiting, and IP rules cannot be trusted. See [TLS & Reverse Proxy](/deployment/tls/).

## Supported Platforms

All images are published as multi-arch (`linux/amd64` + `linux/arm64`):

- Standard Linux servers (Debian, Ubuntu, Rocky, etc.)
- NAS appliances (Synology, UGREEN, TrueNAS) with Docker support
- Raspberry Pi 4/5 and other ARM boards
- Windows via Docker Desktop with WSL2
- macOS via Docker Desktop (development only)

## Requirements

| Component | Minimum |
|---|---|
| Docker Engine | 24+ |
| Docker Compose | v2 |
| RAM | 2 GB (full stack) |
| CPU | 1 core (4 cores recommended) |
| Disk | 500 MB for images + data |
