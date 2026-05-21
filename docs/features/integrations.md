---
label: Integrations
icon: plug
order: 840
description: Connect Weavestream to external platforms via built-in integration drivers.
---

# Integrations

Weavestream's integration layer synchronises data from third-party platforms directly into your tenant asset records. A shared sync orchestration engine handles scheduling, conflict detection, and error reporting — each provider is implemented as a thin driver on top of that foundation.

![Integrations](./assets/integrations.png)

## How It Works

1. **Configure** an integration for a tenant — supply provider credentials and map the integration to the target company.
2. **Sync runs** on demand or on a schedule. The orchestrator calls the provider driver, which fetches records and upserts them into Weavestream assets.
3. **Review** sync status, last-run timestamps, and any errors from the integration detail page.

## Available Integrations

### Action1

**Action1** is an endpoint management platform for remote monitoring and management (RMM) of Windows endpoints.

The Weavestream Action1 driver imports endpoint records from your Action1 account as asset records in the mapped tenant. Synced data includes:

| Field | Description |
|---|---|
| Hostname | Machine name |
| OS version | Windows build and edition |
| Last seen | Last check-in timestamp |
| Agent status | Online / offline / pending |
| Hardware details | CPU, RAM, disk |

**Setup:**
1. Navigate to **Admin → Integrations → New Integration**
2. Select **Action1** as the provider
3. Enter your Action1 API key and organisation ID
4. Map the integration to a Weavestream company
5. Click **Save & Sync** to run an initial import

Subsequent syncs can be triggered manually or will run automatically when background sync is enabled.

### NinjaOne

**NinjaOne** is a unified RMM platform for monitoring and managing workstations, servers, and network gear.

The Weavestream NinjaOne driver imports detailed device records from your NinjaOne organisations as asset records in the mapped tenant. Each NinjaOne organisation maps to a single Weavestream company, so multi-tenant MSPs can fan out one NinjaOne account across many tenants.

The driver exposes two independent **resources** that can each project onto a different asset layout:

| Resource | Devices included | Typical layout |
|---|---|---|
| **Agent devices** (`records`) | Workstations and servers running the NinjaOne agent (Windows, macOS, Linux) | Computers / Endpoints layout — full agent-reported data: OS, hardware, processor, memory, volumes, warranty, owner |
| **Network & non-agent devices** (`nms`) | NMS-discovered switches, firewalls, printers, VoIP gear; VMware / Hyper-V / Xen guest VMs and hypervisor management nodes — anything tracked without a local agent | Network devices / Virtual machines layout — limited fields (network identity, location, parent device) |

The agent-devices resource is configured by default. The network & non-agent resource is **optional** — leave it unconfigured to ignore those devices entirely, or assign a layout, match key, and field mappings to start syncing them into a separate part of your asset inventory.

Synced data includes (mappable to your asset layout fields):

| Category | Fields |
|---|---|
| Identity | System name, DNS name, NetBIOS name, display name, device UID, node class, device type, tags |
| Operating system | OS name, manufacturer, architecture, build number, release ID, language, locale, last boot time, needs-reboot flag |
| Hardware | Make, model, serial number, BIOS serial, asset serial, chassis type, domain, virtual-machine flag |
| Processor | Name, architecture, core count, logical core count, clock speed (raw Hz + readable GHz) |
| Memory | Capacity in raw bytes + readable size (e.g. "127.5 GB") |
| Volumes | Per-volume count, primary volume detail, plus a multi-line summary covering every volume |
| Network | Public IP, primary IP address, primary MAC address, full IP / MAC arrays |
| Location | Name, address, description |
| Organisation | Name, description |
| Role & policy | Role name, policy name, role-policy name, parent policy IDs |
| Warranty | Start date, end date, manufacturer fulfilment date |
| Assigned owner | Name, email, phone, user type, invitation status |
| Maintenance | Status, scheduled start / end, reason |
| Lifecycle | Created, last contact, last update, approval status, offline state |

**Setup:**
1. In NinjaOne, go to **Administration → Apps → API** and create an API client with the **monitoring** scope. NinjaOne returns a Client ID and Client Secret.
2. In Weavestream, navigate to **Admin → Integrations → New Integration**
3. Select **NinjaOne RMM** as the provider
4. Enter your Client ID and Client Secret. Override the API base URL if your tenant lives outside the US region (`eu.ninjarmm.com`, `ca.ninjarmm.com`, `oc.ninjarmm.com`).
5. Click **Test connection** to confirm the credentials reach your NinjaOne tenant
6. Open the **Orgs** tab, pick the NinjaOne organisation, and map it to a Weavestream company. Optionally restrict by location ID.
7. On the **Agent devices** resource tab, pick the asset layout for agent endpoints, set the match key (the **device UID** is recommended — it's NinjaOne's stable GUID and matches reliably across IP / MAC / hostname changes), and configure field mappings. The field list refreshes from a live sample of your tenant, so any custom agent fields the NinjaOne agent reports show up automatically alongside the curated set above.
8. *(Optional)* If you want NMS / VM data in Weavestream, repeat the same steps on the **Network & non-agent devices** resource tab — pick a different layout, set the match key, and choose the relevant network / virtual-machine fields. Skip this tab if you only want agent-managed devices.
9. Click **Save & Sync** to run an initial import.

Subsequent syncs can be triggered manually or will run automatically when background sync is enabled.

### UniFi

**UniFi** is Ubiquiti's network management platform for gateways, switches, access points, and clients.

The Weavestream UniFi driver imports network inventory from your UniFi controller as asset records in the mapped tenant. Synced data includes:

| Field | Description |
|---|---|
| Device name | UniFi device display name |
| Model | Hardware model identifier |
| Site | UniFi site the device belongs to |
| IP address | Current management IP |
| MAC address | Device MAC |
| Firmware | Installed firmware version |
| Last seen | Last controller check-in timestamp |
| Status | Online / offline state |

**Setup:**
1. Navigate to **Admin → Integrations → New Integration**
2. Select **UniFi** as the provider
3. Enter your UniFi controller URL and API credentials
4. Map the integration to a Weavestream company
5. Click **Save & Sync** to run an initial import

Subsequent syncs can be triggered manually or will run automatically when background sync is enabled.

### Cloudflare Zero Trust Lists

**Cloudflare Zero Trust Lists** lets you manage Cloudflare Zero Trust Gateway IP lists directly from Weavestream. Instead of editing lists on the Cloudflare dashboard, you add, update, and remove IP entries in Weavestream and changes are pushed to Cloudflare immediately.

Weavestream is the source of truth. A background drift sweep detects and automatically corrects any out-of-band edits made on the Cloudflare side.

| Field | Description |
|---|---|
| IP address / CIDR | IPv4, IPv6, or CIDR block |
| Description | Optional label stored alongside the entry |
| Drift status | In sync, Drift detected, or Error |
| Last pushed | Timestamp of the most recent successful push to Cloudflare |

For full setup instructions — including how to create the Gateway list, application policy, and API token — see the [Cloudflare Zero Trust IP Lists guide](/guides/cloudflare-zero-trust-ip-lists/).

**Setup:**
1. Navigate to **Admin → Integrations → New Integration**
2. Select **Cloudflare Zero Trust Lists** as the provider
3. Enter your Cloudflare Account ID and an API token scoped to **Zero Trust: Edit**
4. Click **Test Connection**, then **Save**
5. Open the integration and click **Link Cloudflare List** to register an existing IP list

## Sync Behaviour

- **Upsert** — records are created on first sync and updated on subsequent runs based on the provider's unique identifier.
- **No automatic deletion** — records removed from the provider are flagged as stale, not deleted, so you retain history.
- **Audit trail** — every sync run and field change is written to the audit log.
