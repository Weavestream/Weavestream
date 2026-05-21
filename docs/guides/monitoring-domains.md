---
label: Monitoring Domains
icon: globe
order: 860
description: Add hostnames and interpret WHOIS, DNS, and TLS check results.
---

# Monitoring Domains

This guide covers adding domains to a tenant's monitoring list and interpreting the check results.

## Adding a Domain

1. Navigate to a tenant's **Domains** section
2. Click **New Domain**
3. Enter the **hostname** (e.g. `example.com`, `api.example.com`)
4. Configure which checks to enable and their thresholds (see below)
5. Click **Save**

The first check runs in the background within a few minutes.

## Configuring Checks

Each domain has three independent check types:

| Check | What it verifies | Recommended threshold |
|---|---|---|
| **WHOIS expiry** | Domain registration renewal deadline | 60 days |
| **DNS validity** | Whether the hostname resolves | N/A (binary) |
| **TLS/SSL expiry** | Certificate expiry and chain validity | 30 days |

For expiry-based checks, set the **days before expiry** threshold. The check status changes to `WARN` when the remaining days falls below this threshold.

Individual checks can be disabled if not applicable (e.g. disable WHOIS for a subdomain that isn't separately registered).

## Reading Check Results

The domain list shows a status badge for each check:

| Status | Meaning |
|---|---|
| **OK** | Healthy and within threshold |
| **WARN** | Approaching expiry threshold or degraded |
| **FAIL** | Expired, invalid, or unreachable |
| **SKIP** | Check disabled or not applicable |

Click on a domain to see the full check history — an append-only list of every check run with timestamps and detailed result data.

## Expiration Dashboard

All domain expirations (WHOIS and TLS) roll up into the **Expirations** dashboard. Access it via:

- **Admin → Expirations** — all tenants
- **[Tenant] → Expirations** — single tenant

The dashboard shows upcoming and past-due expirations across domains, assets, and passwords in one view.

## Making Domains Visible to Clients

To expose a domain's status to the client portal:

1. Open the domain's detail page
2. Toggle **Visible to clients** to on

The domain and its check history will then appear in the [client portal](/features/client-portal/) for that tenant.

## Check Frequency

Checks are run by the `worker` service via BullMQ. The default schedule runs all checks periodically. If a domain check fails, it is retried with exponential backoff.

## Troubleshooting

**WHOIS check always failing:**  
Some TLDs don't expose expiry dates via public WHOIS. Consider disabling the WHOIS check for those domains.

**TLS check failing for an internal hostname:**  
The worker performs a real TLS handshake. Internal hostnames with self-signed certificates will fail chain validation. Either disable the TLS check or add the certificate to the worker's trust store (advanced configuration).

**DNS check failing despite the domain resolving:**  
The check uses the worker container's DNS resolver, which may differ from your local machine. Verify the domain resolves from inside Docker with `docker compose exec worker nslookup <hostname>`.
