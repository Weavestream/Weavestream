---
label: TLS & Reverse Proxy
icon: shield-lock
order: 800
description: Configure HTTPS with Nginx, Caddy, Traefik, or Cloudflare in front of Weavestream.
---

# TLS & Reverse Proxy

Weavestream does not terminate TLS. Place a reverse proxy in front of the `web` container (port 3000) to handle HTTPS.

:::warning
Running `web` directly internet-facing (no reverse proxy) forces `TRUST_PROXY_HOPS=0`, which disables meaningful per-IP rate limiting, lockout, audit attribution, and IP allow/deny rules. See [Client IP Attribution](/configuration/security/#client-ip-attribution) for the trade-off. For any production deployment, run a trusted TLS proxy in front of `web`.
:::

## Deployment topology

The supported production shape puts a trusted proxy you control in front of `web`:

```
Internet → trusted TLS proxy (Nginx/Caddy/Traefik) → web:3000 → api:4000
                                                          ↓
                                                     postgres / redis
```

**Direct exposure of the `web` port (default `3000`) is for local/LAN use only.** `compose.yml` publishes that port on every host interface so a fresh `docker compose up` works out of the box, but that is not a safe internet-facing posture on its own:

- With a trusted proxy in front and `TRUST_PROXY_HOPS=1` (the default), `web` resolves the real client IP from the proxy's `X-Forwarded-For` and forwards a single sanitized entry to the API. IP-based controls work correctly.
- With **no** proxy and `TRUST_PROXY_HOPS=1`, a client can send their own `X-Forwarded-For` and choose the IP that audit logs, per-IP lockout, rate limiting, and IP allow/deny rules see.
- With **no** proxy and `TRUST_PROXY_HOPS=0`, forging is prevented but every request collapses to the `0.0.0.0` sentinel, disabling those same controls. See [Client IP Attribution](/configuration/security/#client-ip-attribution).

Either direct-public shape is weak, so run the proxy.

:::note
The API emits a `[Topology]` warning in its startup logs when it detects a likely-unsafe public configuration — a plain-HTTP `APP_URL` on a public host, or `TRUST_PROXY_HOPS=0` on a public host. It is informational only and never blocks startup, but it makes a misconfigured direct-public deployment visible in `docker compose logs api`. The default `http://localhost:3000` stays quiet.
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

Weavestream reads only `X-Forwarded-For`; `X-Real-IP` is ignored. Next.js fills a missing `X-Forwarded-For` with the address of the connection before Weavestream sees the request, so a proxy that sends only `X-Real-IP` is recorded as its own address.

Set `TRUST_PROXY_HOPS` to the number of trusted reverse-proxy hops **between the internet and the `web` container** — i.e. the edge tier you run in front of compose. The default `1` matches a single operator-managed proxy (Caddy, Nginx, Traefik, …) or a Cloudflare Tunnel that connects straight to `web`. A CDN or tunnel in front of your own proxy adds a hop **only if that proxy trusts it and appends to `X-Forwarded-For`**. A proxy that replaces the header discards every entry in front of it, including the client, and no `TRUST_PROXY_HOPS` value can bring that entry back. See [Cloudflare](#cloudflare) for the common layered setups.

The web tier reads `TRUST_PROXY_HOPS` to resolve the real client IP from the inbound `X-Forwarded-For` chain and then forwards a single sanitized entry to the API. The API itself does not use this knob — it honors `X-Forwarded-For` only when the TCP peer is on the private docker bridge (loopback / link-local / unique-local), which is automatically true for the `web` container. See [Security Configuration](/configuration/security/#client-ip-attribution) for the full model.

### Find the correct `TRUST_PROXY_HOPS`

Read the value from a real request rather than from a diagram of your network:

1. From a device **outside** your network, sign in through your public URL and open **Security Center → Connection** (`/admin/security?tab=diagnostics`).
2. Find your public IP address. Behind Cloudflare, open `https://your-domain.com/cdn-cgi/trace` in the same browser and read the `ip=` line.
3. Find that address in the **Inbound chain** row.
4. Count that entry plus every entry to its right. The total is the correct `TRUST_PROXY_HOPS`.
5. Set the value in `.env` and recreate **both** containers: `docker compose up -d --force-recreate web api`. Re-run the check: **Resolved client IP** must now be your public IP.

| Inbound chain (your public IP is `198.51.100.7`) | Correct `TRUST_PROXY_HOPS` |
|---|---|
| `198.51.100.7` | `1` |
| `1.2.3.4, 198.51.100.7` | `1` — the client sent `1.2.3.4`; entries to the left of your IP are ignored |
| `198.51.100.7, 162.158.1.2` | `2` — Cloudflare edge → your proxy |
| `198.51.100.7, 172.18.0.4` | `2` — `cloudflared` → your proxy |
| `172.18.0.4` | No value works. A proxy replaced `X-Forwarded-For`; fix that proxy first. |

The **TRUST_PROXY_HOPS** row shows the value the web tier applied to your request next to the value in the API container's environment. The web value is the one in effect, because the web tier resolves the client IP. If the two differ, only one container was recreated after the last `.env` change.

!!!warning Never set a value higher than the real hop count
Entries to the left of your real address are written by the client. Cloudflare keeps an `X-Forwarded-For` header that the client sent and appends the real address after it, so a client can send `X-Forwarded-For: 1.2.3.4` and reach `web` with the chain `1.2.3.4, 198.51.100.7`. With the correct `TRUST_PROXY_HOPS=1`, Weavestream records `198.51.100.7`. With `TRUST_PROXY_HOPS=2`, it records `1.2.3.4` — the client has chosen the IP that audit logs, per-IP lockout, rate limiting, and IP allow/deny rules see.
!!!

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

Caddy handles certificate issuance and renewal automatically via Let's Encrypt. Its `reverse_proxy` sets `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` by itself, so the site needs no `header_up` lines:

```
your-domain.com {
    reverse_proxy localhost:3000

    # Increase upload limit
    request_body {
        max_size 50MB
    }
}
```

By default Caddy ignores any `X-Forwarded-For` it receives and sends only the address of the client that connected to it. That is correct when Caddy faces the internet (`TRUST_PROXY_HOPS=1`). If Cloudflare, `cloudflared`, or another proxy sits in front of Caddy, Caddy must trust that proxy so it keeps the incoming chain and appends to it. See [Cloudflare](#cloudflare).

!!!warning Remove header_up X-Forwarded-For from existing Caddyfiles
Earlier versions of this page included `header_up X-Forwarded-For {remote_host}` and `header_up X-Forwarded-Proto {scheme}`. Without a `+` or `-` prefix, `header_up` **replaces** a header, and Caddy applies it after its own forwarding logic, so only the address of the hop directly in front of Caddy survives. Behind Cloudflare or `cloudflared`, that hop is the Cloudflare edge or the tunnel container: the client entry is gone, and no `TRUST_PROXY_HOPS` value can recover it. Caddy itself logs `Unnecessary header_up X-Forwarded-For` for this line. Delete both lines.
!!!

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

## Cloudflare

Cloudflare sits in front of your stack in one of two ways: as a proxy in front of your own reverse proxy (a proxied DNS record), or as a Cloudflare Tunnel, where `cloudflared` connects out to Cloudflare and forwards requests to `web` or to your proxy. In both cases Cloudflare appends the visitor's address to `X-Forwarded-For`, after any value the visitor sent. Through a tunnel, the rightmost entry that reaches the origin is the visitor's address; `cloudflared` does not add its own.

| Topology | `TRUST_PROXY_HOPS` | Requirement |
|---|---|---|
| Cloudflare → Caddy or Nginx → `web` | `2` | The proxy trusts Cloudflare's IP ranges and appends to `X-Forwarded-For`. |
| Cloudflare Tunnel: `cloudflared` → `web` | `1` | Nothing to configure, but do not also expose the `web` port directly. |
| Cloudflare Tunnel: `cloudflared` → Caddy or Nginx → `web` | `2` | The proxy trusts the address `cloudflared` connects from and appends to `X-Forwarded-For`. |

These are the expected values. Confirm yours with [Find the correct `TRUST_PROXY_HOPS`](#find-the-correct-trust_proxy_hops).

**Caddy behind Cloudflare.** Trust Cloudflare's published ranges in the global `servers` block. Caddy then keeps Cloudflare's `X-Forwarded-For` and appends the address of the Cloudflare edge. A client that bypasses Cloudflare and connects to Caddy directly is not trusted, so its header is still replaced:

```
{
    servers {
        # Cloudflare's ranges from https://www.cloudflare.com/ips/ — Caddy
        # takes them on one line. Re-check the list when you upgrade Caddy.
        trusted_proxies static 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
    }
}

your-domain.com {
    reverse_proxy localhost:3000

    request_body {
        max_size 50MB
    }
}
```

**Caddy behind `cloudflared`.** In the same global `servers` block, trust only the Docker network that `cloudflared` connects from, for example `trusted_proxies static 172.18.0.0/16` (read the subnet with `docker network inspect <network>`). Avoid `private_ranges` unless nothing else on your LAN can reach Caddy: every address Caddy trusts can write its own `X-Forwarded-For`.

**Nginx behind Cloudflare.** The Nginx example above uses `$proxy_add_x_forwarded_for`, which appends the connecting address to any `X-Forwarded-For` the client sent. With `TRUST_PROXY_HOPS=1` that is safe, because Weavestream reads the rightmost entry, which Nginx wrote. With `TRUST_PROXY_HOPS=2`, a client that connects to Nginx directly controls the entry Weavestream reads. Accept connections to Nginx only from Cloudflare's IP ranges, or only from `cloudflared`.

**`cloudflared` straight to `web`.** Point the tunnel's public hostname at `http://web:3000` when `cloudflared` joins the compose network, or at `http://localhost:3000` when it runs on the host. Keep `TRUST_PROXY_HOPS=1`. A request that reaches `web` without the tunnel can choose its own `X-Forwarded-For`, so remove the published `web` port or bind it to loopback (see the next section).

## Bind `web` to loopback (proxy on the same host)

If your reverse proxy runs on the **same host** as the Compose stack, there's no reason to publish `web` on every interface. Bind it to loopback so the port is reachable only by the local proxy, not by anything else on the network. In `compose.yml`, change the `web` port mapping to:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:${WEB_HOST_PORT:-3000}:3000"
```

Then point the proxy at `127.0.0.1:3000` (the examples above already do). The default mapping (`"${WEB_HOST_PORT:-3000}:3000"`) binds all interfaces, which is only appropriate when the proxy lives on a different host and reaches `web` over the LAN.

## Verify forged `X-Forwarded-For` is ignored

After your proxy is in place, confirm that a client cannot choose their own audit IP. From a machine **outside** your network, drive a failed login through the proxy with a forged header, then check what Weavestream recorded. The login endpoint is CSRF-protected, so fetch a token first and replay it with the spoofed request:

```bash
# 1. Get a CSRF token + cookie into a jar.
TOKEN=$(curl -k -s -c cookies.txt -X POST https://your-domain.com/api/v1/auth/csrf \
  | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')

# 2. Attempt a failed login through the proxy with a spoofed X-Forwarded-For.
curl -k -i -b cookies.txt -X POST https://your-domain.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $TOKEN" \
  -H 'X-Forwarded-For: 1.2.3.4' \
  --data '{"email":"nobody@example.com","password":"wrong"}'
```

Then open **Security Center → Audit log** (or query the audit table) and find the resulting `auth.login.failure` row. With the supported single-proxy topology and `TRUST_PROXY_HOPS=1`, the recorded IP is your **real** public address — not `1.2.3.4`. The proxy puts the real peer address in the rightmost position of `X-Forwarded-For` (Caddy replaces the header, Nginx appends to it), `web` takes the entry `TRUST_PROXY_HOPS` from the right and re-sanitizes it to a single entry, and the API trusts that entry only because it arrived from the private docker bridge.

If you instead see `1.2.3.4`, `TRUST_PROXY_HOPS` is higher than the number of proxies actually in front of `web`, your proxy forwards the client's `X-Forwarded-For` without adding the real peer address, or the request reached `web` without passing through the proxy. If you see `0.0.0.0`, `TRUST_PROXY_HOPS=0` is in effect (expected only for an intentional direct-internet deployment). See [Client IP Attribution](/configuration/security/#client-ip-attribution).

### Connection diagnostics endpoint

For a faster check that does not require reading the audit log, an admin with the **View Security Center** (`SECURITY_READ`) capability can call the diagnostics endpoint, which reports how Weavestream attributed **that exact request**:

```bash
# Reuse the CSRF token + cookie jar from the login test above, and a
# signed-in admin session cookie. GET needs no CSRF token.
curl -k -s -b cookies.txt \
  -H 'X-Forwarded-For: 1.2.3.4' \
  https://your-domain.com/api/v1/security/whoami | jq
```

The same view is available in the browser at **Security Center → Connection** (`/admin/security?tab=diagnostics`).

The response includes `resolvedIp` (the value every per-IP control uses), `socketPeer`, `peerTrusted`, `forwardedForReceived`, `inboundForwardedFor` (the raw `X-Forwarded-For` chain the web tier received from its immediate upstream — echoed for comparison, never used for attribution; a proxy that replaces the header may already have dropped a client's forged value, while Cloudflare and Nginx keep it to the left), `webTrustProxyHops` (the `TRUST_PROXY_HOPS` value the web tier applied to this request — the one in effect; `null` if the web tier did not report one), `trustProxyHops` (the value in the API container's environment, for comparison), and plain-English `interpretation` notes. The notes flag a hop-count mismatch between `web` and `api`, an inbound chain with fewer entries than the hop count (the web tier then silently uses the leftmost entry), and a `resolvedIp` that is a private, loopback, or link-local address such as a Docker bridge address.

**Expected results are topology-specific.** Read them against your actual edge:

| Topology | Expected `resolvedIp` / `inboundForwardedFor` | Meaning |
|---|---|---|
| Trusted TLS proxy in front of `web`, `TRUST_PROXY_HOPS=1` (supported) | `resolvedIp` and the rightmost `inboundForwardedFor` entry are your **real public IP**. Caddy drops the forged `1.2.3.4`; Nginx keeps it to the left | **Pass.** Entries to the left of your IP are ignored. |
| CDN → edge → `web`, `TRUST_PROXY_HOPS=2` | `inboundForwardedFor` ends with `<your IP>, <CDN edge>`, and Cloudflare also keeps the forged `1.2.3.4` to the left; `resolvedIp` is the entry two hops from the right — your real IP | **Pass.** Entries to the left of your IP are ignored. |
| Cloudflare Tunnel, `cloudflared` → `web`, `TRUST_PROXY_HOPS=1` | `inboundForwardedFor` is `1.2.3.4, <your IP>`; `resolvedIp` is your real IP | **Pass.** |
| Cloudflare Tunnel, `cloudflared` → proxy → `web`, `TRUST_PROXY_HOPS=2` | `inboundForwardedFor` is `1.2.3.4, <your IP>, <cloudflared address>`; `resolvedIp` is your real IP | **Pass.** |
| Direct `curl http://localhost:3000` with no real edge, `TRUST_PROXY_HOPS=1` | Both show `1.2.3.4` | **Negative example — why direct web exposure is unsafe.** The web tier trusted your forged header. |

:::warning
In that last (direct, no-edge) case the endpoint still reports `peerTrusted: true`, because the API's TCP peer is the `web` container regardless of how `web` was reached. `peerTrusted` reflects only the API↔peer hop — **it cannot tell whether `web` sat behind a trusted edge proxy or was hit directly.** The endpoint's only self-detected hint for that misconfiguration is the config-derived topology note in `interpretation` (echoing the same `[Topology]` boot warnings). The authoritative proof that spoofing is discarded is this test run **from an external machine through your real proxy**, not from `localhost`.
:::

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
| **Resolved client IP** on the Connection tab is a Docker address (for example `172.18.0.4`) | Check the **Inbound chain** row. If your public IP is in it, `TRUST_PROXY_HOPS` is too low: follow [Find the correct `TRUST_PROXY_HOPS`](#find-the-correct-trust_proxy_hops). If it is not, the client entry was lost before `web`. A proxy replaced `X-Forwarded-For` with the address of the hop in front of it (Caddy with `header_up X-Forwarded-For {remote_host}`, or Caddy behind `cloudflared` without `trusted_proxies`), or nothing set the header and `web` recorded the proxy's own address (for example with Cloudflare's **Remove visitor IP headers** Managed Transform). Fix the proxy: no `TRUST_PROXY_HOPS` value can recover a lost entry. |
| The Connection tab shows different `TRUST_PROXY_HOPS` values for web and API | Only one container was recreated after `.env` changed. The web value is in effect. Run `docker compose up -d --force-recreate web api`. |
