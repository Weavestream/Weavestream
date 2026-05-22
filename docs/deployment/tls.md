---
label: TLS & Reverse Proxy
icon: shield-lock
order: 800
description: Configure HTTPS with Nginx, Caddy, or Traefik in front of Weavestream.
---

# TLS & Reverse Proxy

Weavestream does not terminate TLS. Place a reverse proxy in front of the `web` container (port 3000) to handle HTTPS.

:::warning
Running `web` directly internet-facing (no reverse proxy) forces `TRUST_PROXY_HOPS=0`, which disables meaningful per-IP rate limiting, lockout, audit attribution, and IP allow/deny rules. See [Client IP Attribution](/configuration/security/#client-ip-attribution) for the trade-off. For any production deployment, run a trusted TLS proxy in front of `web`.
:::

## Required Environment Variables

Before configuring your proxy, update `.env` with the public HTTPS URLs:

```bash
APP_URL=https://your-domain.com
API_URL=https://your-domain.com/api
```

Browsers stream every uploaded file (thumbnails, attachments, logos, export PDFs) through the API on the same origin as the web app, so there is no second virtual host to configure.

Restart the stack after changing these: `docker compose up -d`

## Client IP Headers

Weavestream records client IPs for audit entries, rate limiting, lockouts, and Security Center views. Your reverse proxy must set `X-Forwarded-Proto: https` and must control the `X-Forwarded-For` chain.

Set `TRUST_PROXY_HOPS` to the number of trusted reverse-proxy hops **between the internet and the `web` container** — i.e. the edge tier you run in front of compose. The default `1` matches a single operator-managed proxy (Caddy, Nginx, Traefik, …). Set `2` if you also have a CDN (e.g. Cloudflare) in front of that edge.

The web tier reads `TRUST_PROXY_HOPS` to resolve the real client IP from the inbound `X-Forwarded-For` chain and then forwards a single sanitized entry to the API. The API itself does not use this knob — it honors `X-Forwarded-For` only when the TCP peer is on the private docker bridge (loopback / link-local / unique-local), which is automatically true for the `web` container. See [Security Configuration](/configuration/security/#client-ip-attribution) for the full model.

## Nginx

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/ssl/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/your-domain.com/privkey.pem;

    # Increase for file uploads
    client_max_body_size 50m;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

## Caddy

Caddy handles certificate issuance and renewal automatically via Let's Encrypt:

```
your-domain.com {
    reverse_proxy localhost:3000 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
    
    # Increase upload limit
    request_body {
        max_size 50MB
    }
}
```

## Traefik (Docker labels)

If you use Traefik as your Docker-aware proxy, add labels to the `web` service in a `compose.override.yml`:

```yaml
services:
  web:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.weavestream.rule=Host(`your-domain.com`)"
      - "traefik.http.routers.weavestream.entrypoints=websecure"
      - "traefik.http.routers.weavestream.tls.certresolver=letsencrypt"
      - "traefik.http.services.weavestream.loadbalancer.server.port=3000"
```

## Self-Signed Certificates (Internal)

For internal deployments where Let's Encrypt isn't available:

1. Generate a self-signed certificate or use an internal CA
2. Configure your proxy to use it
3. Distribute the CA certificate to browsers/clients that will access the instance
4. If the worker needs to make TLS checks against internal domains using your CA, mount the CA certificate into the `worker` container

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Image uploads fail with CORS / CSP errors | `APP_URL` doesn't match the hostname browsers use to load the app |
| Login redirects to `http://` | `APP_URL` is set to `https://` but cookie was set with wrong domain |
| 413 Request Entity Too Large | Proxy upload size limit lower than `MAX_UPLOAD_MB` |
| 502 Bad Gateway | `web` container not running or proxy pointing at wrong port |
| Audit log shows the proxy IP for every request | `TRUST_PROXY_HOPS` is too low for your edge tier, or the proxy is not setting `X-Forwarded-For` correctly |
