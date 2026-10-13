---
label: UniFi
icon: plug
description: Connect Ubiquiti UniFi controllers to sync network gateways, switches, access points, and clients.
---

# UniFi Integration

**UniFi** is Ubiquiti's networking ecosystem for gateways, switches, access points, network controllers, and connected client devices.

The Weavestream UniFi driver imports network hardware inventory and connected client records through the UniFi Site Manager API into tenant asset records.

## Overview & Features

- **Host-to-Company Mapping**: Map UniFi hosts or consoles to individual Weavestream companies.
- **Infrastructure & Client Ingestion**: Syncs UniFi hardware nodes (gateways, switches, APs) as well as discovered client devices.
- **Real-Time Network Telemetry**: Keeps IP address, MAC address, firmware version, and online/offline status updated.
- **Separate Device and Client Resources**: Project managed infrastructure and connected clients into independently configured asset layouts.

## Synced Data Reference

The UniFi driver extracts the following network hardware and client fields:

| Field | Description | Data Type |
|---|---|---|
| **Device Name** | UniFi device or client display name | Text / String |
| **Model** | Hardware model identifier (e.g. `USG-PRO-4`, `USW-Pro-24-PoE`, `U6-Pro`) | Text |
| **Site** | Name of the source UniFi site | Text |
| **IP Address** | Current management IP address | IP Address |
| **MAC Address** | Hardware MAC address | Text |
| **Firmware** | Installed UniFi OS or device firmware version | Text |
| **Last Seen** | Last controller check-in timestamp | Date / Timestamp |
| **Status** | Current operational status (`Online`, `Offline`, `Adopting`) | Single Select / Text |

## Setup Instructions

The **Credentials & schedule** tab shows the same steps as a setup guide. Press **Check setup** there to verify steps 1 and 2. Check setup does not check the console mappings in step 3.

### Prerequisites

- A UI account that is **Owner** or **Super Admin** of the UniFi consoles to inventory.
- A UniFi Site Manager **API key** created with that account.

### Step 1: Create a Site Manager API key in UniFi

1. Sign in to UniFi Site Manager at [unifi.ui.com](https://unifi.ui.com) with the UI account that is Owner or Super Admin of your consoles.
2. Open **Settings → API Keys**.
3. Press **Create New API Key**.
4. Copy the key. UniFi shows it only once. If you lose it, create a new key.

About the key:

- The key belongs to the UI account that created it, and sees what that account sees.
- Site Manager lists devices only for consoles where that account is Owner or Super Admin.
- Site Manager API keys are read-only. Weavestream only reads from UniFi.
- The Site Manager API v1 allows 10,000 requests per minute. Above that, it returns HTTP 429 with a `Retry-After` header, and Weavestream waits and tries again.

See Ubiquiti's [Site Manager API: Getting Started](https://developer.ui.com/site-manager/v1.0.0/gettingstarted) and [List Devices](https://developer.ui.com/site-manager/v1.0.0/listdevices) pages.

### Step 2: Paste the key into Weavestream

1. In Weavestream, open **Admin → Integrations → New Integration**.
2. Select **UniFi Site Manager**.
3. Enter the **API Key**. Leave **API Base URL** at its default, `https://api.ui.com`.
4. Select **Create**. New integrations start paused.
5. On **Credentials & schedule**, press **Test connection**, then **Check setup**.

### Step 3: Map each UniFi console to a company

Open **Organizations**. Each UniFi console (Site Manager calls it a host) that the key can see is listed. Map each one to its Weavestream company.

Devices sync from Site Manager. Clients are read through the console itself, from every site on it, through Ubiquiti's [cloud connector](https://developer.ui.com/network/v10.6.106/connectorget):

- The console must be online when the sync runs.
- UniFi can refuse client reads when the key's account is not the owner of the console.

### Step 4: Map device and client fields

1. Open **Devices fields**. Pick the asset layout for gateways, switches and access points, the match key (`mac` is suggested), and the field mappings.
2. Open **Clients fields** and do the same for connected clients. The match key `name` is suggested, because UniFi's client list does not include the MAC address.

### Step 5: Dry run, then sync

1. On **Credentials & schedule**, set **Status** to active and select **Save changes**.
2. Press **Dry run** and review the result in **Run history**.
3. Press **Run sync now** for the initial import.

### Check setup results

Check setup reads one page of the Site Manager device list (`GET /v1/devices`). It does not read clients.

| Result | Step to revisit |
|---|---|
| No API key is saved, or the API Base URL is not a valid URL | Step 2 |
| UniFi does not accept the API key (HTTP 401) | Steps 1 and 2 |
| The key's account has no permission (HTTP 403), or the key sees no consoles | Step 1 |
| The API Base URL does not resolve, points to a private address, or is not the Site Manager API (HTTP 404 or a non-JSON answer) | Step 2 |
| UniFi is rate limiting, returns a server error, or cannot be reached | Try again later |

Check setup never shows UniFi's own error text.

The shipped driver uses the cloud-hosted UniFi Site Manager APIs; it does not connect directly to a local controller with a controller username and password.
