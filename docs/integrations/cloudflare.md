---
label: Cloudflare
icon: plug
description: Manage Cloudflare Zero Trust Gateway IP lists and keep every domain on the Cloudflare account in Domains.
---

# Cloudflare Integration

One **Cloudflare** integration connects one Cloudflare account. It has two independent features. Use either one, or both:

| | Zero Trust Gateway IP lists | Domain sync |
|---|---|---|
| **What it does** | Manage the IP and CIDR entries of Gateway lists in Weavestream | Keep every domain on the account in **Domains**, with registrar facts |
| **Direction** | Weavestream → Cloudflare. Weavestream is the source of truth. | Cloudflare → Weavestream. Cloudflare is the source of truth for registrar facts. |
| **Turned on by** | Registering a list on the **Lists** tab | Setting **Sync domains into company** |
| **Token permissions** | Account » Zero Trust » Edit | Zone » Zone » Read, and read access to Registrar |
| **On each scheduled run** | Drift check and repair of every registered list | Registrar sync |

## Setup

### Prerequisites

- The Cloudflare **Account ID**. It is on the overview page of the Cloudflare dashboard.
- A Cloudflare **API Token** for that account, with the permissions of the features you use.

### Permissions

Give the token only what you use:

| Feature | Permission |
|---|---|
| Zero Trust Gateway IP lists | **Account » Zero Trust » Edit**. Do not use "Account Filter Lists": that is the unrelated WAF Rules Lists API, which Tunnel access policies do not read. |
| Domain sync | **Zone » Zone » Read** for every zone on the account, and read access to **Registrar** for the account |

Set **Account Resources** to the account the integration connects.

### Create the API token

1. In the **Cloudflare Dashboard**, open **My Profile → API Tokens → Create Token**.
2. Select **Create Custom Token**.
3. Add the permissions from the table above.
4. Set **Account Resources** to your account.
5. Click **Continue to Summary**, then **Create Token**. Copy the token. Cloudflare shows it only once.

### Add the integration

1. In Weavestream, open **Admin → Integrations → New Integration**.
2. Select **Cloudflare** as the provider.
3. Enter the **Cloudflare Account ID** and the **API Token**.
4. To use domain sync, also set **Sync domains into company (slug)**. You can also do this later.
5. Click **Test connection**, then **Save**.

**Test connection** checks the feature the integration is set up for:

- **Domain sync off:** it reads the Gateway lists. A token without Zero Trust access fails.
- **Domain sync on:** it reads the zone and registrar lists, and fails if either is not readable. It also tries the Gateway lists. If the token has no Zero Trust access, the result says so but the test still passes, because a domains-only integration never calls the Gateway API.

### Schedule

One schedule runs both features. On each run, Weavestream checks every registered list and repairs drift, then runs the domain sync if it is on. A blank schedule uses the global default (every 15 minutes unless an administrator changed it).

## Zero Trust Gateway IP lists

Manage Cloudflare Zero Trust Gateway IP lists from Weavestream instead of editing them in each Cloudflare dashboard. You add, update and remove IP and CIDR entries in Weavestream, and each change is pushed to Cloudflare at once.

### Capabilities

- **Push to Cloudflare**: every entry change is sent to Cloudflare immediately.
- **Drift detection and repair**: each scheduled run compares Cloudflare with Weavestream and corrects changes made directly in Cloudflare.
- **IPv4 and IPv6**: single addresses and CIDR blocks (for example `192.168.1.0/24` and `2601:280:5280:7bc0::/64`).
- **Several lists**: register more than one Gateway IP list under one integration.

### Managed attributes

| Attribute | Description | Format |
|---|---|---|
| **IP Address / CIDR** | A single host or a network prefix | IPv4 (`192.168.1.1`), IPv4 CIDR (`10.0.0.0/16`), IPv6 (`2001:db8::1`), IPv6 CIDR (`2601:280:5280::/64`) |
| **Description** | Optional label for the entry | Text stored with the entry |
| **Drift Status** | State compared with Cloudflare | `In sync`, `Drift detected` or `Error` |
| **Last Pushed** | Time of the last successful push | Date and time |

### Register a Gateway list

1. Open the Cloudflare integration and select the **Lists** tab.
2. Click **Register list**.
3. Select a Gateway IP list from the lists found on the account.
4. Click **Register**. Weavestream imports the existing entries and manages the list from then on.

> [!NOTE]
> For step-by-step instructions, including Cloudflare Gateway policies and firewall rules, see the [Cloudflare Zero Trust IP Lists guide](/guides/cloudflare-zero-trust-ip-lists/).

## Domain sync

Keep **Domains** in step with every domain on the Cloudflare account: Cloudflare Registrar registrations and DNS zones alike. Each synced domain has an orange **Cloudflare** tag, so it is never confused with a domain entered by hand.

### What is synced

| Field | Source |
|---|---|
| Registrar | `Cloudflare` for a Cloudflare Registrar registration; empty for a zone registered elsewhere |
| Expires / Registered | Registration |
| Auto-renew | Registration; shown as **manual** in the Domains table when off |
| Transfer lock, registration status | Registration (`active`, `expired`, `redemption_period`, …) |
| Nameservers | The zone's assigned nameservers |

Weavestream reads Cloudflare's [Registrar registrations API](https://developers.cloudflare.com/api/resources/registrar/subresources/registrations/methods/list/). The older `/registrar/domains` endpoints reached end of life on September 27, 2026 and are not used. The registrations API only knows domains that Cloudflare Registrar holds, so a zone whose registration is at another registrar shows no registrar facts; the domain's WHOIS check still reports its expiry.

Weavestream owns everything else on the row: the company it belongs to, the monitoring toggles and client visibility. The sync only rewrites the registrar fields above.

### Turn it on

1. Make sure the API token has the domain sync permissions (see [Permissions](#permissions)).
2. Under **Credentials & schedule**, set **Sync domains into company (slug)** to the company that new domains go to. Saving checks that **you** can manage domains in that company. The company is then stored by id, so a later slug rename does not break the sync.
3. Click **Test connection**. With domain sync on, it checks the zone and registrar lists. On a 401 or 403 it shows Cloudflare's own error text.
4. Make sure the integration has a schedule. The **Domains** tab also has a **Sync domains now** button that queues a run at once.

### Behaviour

- **New domains** (e.g. a domain you just bought) are created in the configured company.
- **Moved domains**: if you move a synced domain to a client company, it stays there; later syncs update it in place.
- **Existing manual entries** with the same hostname **in the configured company** are taken over (they turn into synced rows). Manual entries in other companies are left alone and the domain is skipped rather than duplicated.
- **Nothing is deleted.** A domain that leaves the account (transferred out, expired, moved to another Cloudflare account) is flagged *not on account since …* and keeps its history; archive it yourself when you are done with it.
- **Archiving is respected.** An archived synced domain is not updated or recreated, even while it is still on the Cloudflare account.
- **Recreating the integration** for the same Cloudflare account reclaims the domains the old one synced.
- A synced domain's hostname cannot be edited, because the sync matches on it.
- If two Cloudflare integrations report the same hostname, only one of them creates it, even when both run at the same moment; the other skips it.
- **All or nothing.** Both Cloudflare lists are read in full before anything is written. Any Cloudflare error (permissions, rate limit, a bad request, an outage) fails the run and changes no domain, so a failed request can never erase stored registrar facts or flag live domains as missing.

### Results and failures

The **Domains** tab shows the latest run, manual or scheduled: queued, running, the counts when it succeeds, or the reason when it fails. It updates on its own while a run is in progress. A Cloudflare error (for example a missing permission) is shown with Cloudflare's own text. Any other failure shows a reference ID instead of technical details; search the server log for that ID.

Each successful run writes one `integration.cloudflare.registrar_sync` audit row listing the created, taken-over, skipped and missing hostnames. A failed run writes `integration.cloudflare.registrar_sync.failed` with the error.
