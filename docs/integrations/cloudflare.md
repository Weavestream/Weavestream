---
label: Cloudflare Zero Trust
icon: plug
description: Manage Cloudflare Zero Trust Gateway IP lists directly from Weavestream with automatic drift detection.
---

# Cloudflare Zero Trust Lists Integration

**Cloudflare Zero Trust Lists** lets you manage Cloudflare Zero Trust Gateway IP lists directly from Weavestream. 

Instead of manually editing IP lists across individual Cloudflare tenant dashboards, you add, update, and remove IP and CIDR entries inside Weavestream. Changes are pushed to Cloudflare immediately, establishing Weavestream as the primary source of truth.

## Key Capabilities

- **Bidirectional Sync & Push**: Manage Cloudflare Zero Trust Gateway IP lists natively within Weavestream.
- **Automated Drift Detection**: A background drift sweep constantly compares Cloudflare state against Weavestream records, detecting and auto-correcting out-of-band edits.
- **IPv4 and IPv6 Support**: Full validation and support for single IP addresses and CIDR prefix blocks (e.g. `192.168.1.0/24` and `2601:280:5280:7bc0::/64`).
- **Multi-List Registration**: Register multiple Cloudflare Gateway IP lists under a single API integration instance.

## Managed Attributes Reference

| Attribute | Description | Support / Format |
|---|---|---|
| **IP Address / CIDR** | Network address prefix or single host | IPv4 (`192.168.1.1`), IPv4 CIDR (`10.0.0.0/16`), IPv6 (`2001:db8::1`), IPv6 CIDR (`2601:280:5280::/64`) |
| **Description** | Optional human-readable description label | String label stored alongside the list entry |
| **Drift Status** | Live status relative to Cloudflare | `In sync`, `Drift detected`, or `Error` |
| **Last Pushed** | UTC timestamp of last successful API push | Date / Timestamp |

## Setup Instructions

### Prerequisites
- A Cloudflare account with Zero Trust enabled.
- Cloudflare **Account ID**.
- A Cloudflare **API Token** with the **Account → Zero Trust → Edit** permission.

### Step 1: Create the Cloudflare API Token
1. Log into your **Cloudflare Dashboard**.
2. Navigate to **My Profile → API Tokens → Create Token**.
3. Select **Create Custom Token**.
4. Set permissions to: **Account → Zero Trust → Edit**.
5. Set **Account Resources** to your target account.
6. Click **Continue to Summary** and **Create Token**. Copy the generated token.

### Step 2: Configure Integration in Weavestream
1. In Weavestream, navigate to **Admin → Integrations → New Integration**.
2. Select **Cloudflare Zero Trust Lists** as the provider.
3. Enter your **Cloudflare Account ID** and the **API Token**.
4. Click **Test Connection** to verify access to your Cloudflare Zero Trust environment.
5. Click **Save**.

### Step 3: Link an Existing Gateway List
1. Open the created Cloudflare integration detail page.
2. Click **Link Cloudflare List**.
3. Select the Gateway list you wish to manage from the list of discovered Cloudflare Zero Trust Gateway lists.
4. Click **Register List**. Weavestream will import existing entries and begin active management.

> [!NOTE]
> For detailed step-by-step instructions—including setting up Cloudflare Gateway policies and firewall rules—see the complete [Cloudflare Zero Trust IP Lists guide](/guides/cloudflare-zero-trust-ip-lists/).

## Domain Registrar Sync

The same integration can keep **Domains** in step with every domain on the Cloudflare account: registrar domains and DNS zones alike. Each synced domain carries an orange **Cloudflare** tag so it is never confused with a hand-entered one.

### What is synced

| Field | Source |
|---|---|
| Registrar | `Cloudflare` for Cloudflare Registrar domains, otherwise the current registrar Cloudflare reports |
| Expires / Registered | Registrar record |
| Auto-renew | Registrar record; shown as **manual** in the Domains table when off |
| Transfer lock, registry status | Registrar record |
| Nameservers | Registrar record, falling back to the zone's assigned nameservers |

Weavestream owns everything else on the row: the company it belongs to, the monitoring toggles and client visibility. The sync only rewrites the registrar fields above.

### Turning it on

1. Add these permissions to the integration's API token: **Account » Registrar: Domains » Read** and **Zone » Zone » Read**.
2. Under **Credentials & schedule**, set **Sync domains into company (slug)** to the company new domains should be filed under. Saving checks that **you** can manage domains in that company; the company is then stored by id, so renaming its slug later does not break the sync.
3. Make sure the integration has a schedule. The registrar sync runs on every drift sweep; the **Domains** tab has a **Sync domains now** button that queues an immediate run in the background.

### Behaviour

- **New domains** (e.g. a domain you just bought) are created in the configured company.
- **Moved domains**: if you move a synced domain to a client company, it stays there; later syncs update it in place.
- **Existing manual entries** with the same hostname **in the configured company** are taken over (they turn into synced rows). Manual entries in other companies are left alone and the domain is skipped rather than duplicated.
- **Nothing is deleted.** A domain that leaves the account (transferred out, expired, moved to another Cloudflare account) is flagged *not on account since …* and keeps its history; archive it yourself when you are done with it.
- **Archiving is respected.** An archived synced domain is not updated or recreated, even while it is still on the Cloudflare account.
- **Recreating the integration** for the same Cloudflare account reclaims the domains the old one synced.
- A synced domain's hostname cannot be edited, because the sync matches on it.
- If two Cloudflare integrations report the same hostname, the second one skips it instead of creating a duplicate.

Each run writes one `integration.cloudflare.registrar_sync` audit row listing the created, taken-over, skipped and missing hostnames.

!!!info Why every domain is fetched individually
Cloudflare's registrar list endpoint can report more domains than it returns. Weavestream unions the zone list with the registrar list and then reads each domain's registrar record on its own, which is authoritative.
!!!
