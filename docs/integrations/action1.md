---
label: Action1
icon: plug
description: Connect Action1 endpoint management RMM to sync Windows workstation and server assets.
---

# Action1 Integration

**Action1** is an endpoint management platform for remote monitoring and management (RMM) of Windows workstations and servers. 

The Weavestream Action1 driver imports endpoint records from your Action1 organisation directly into tenant asset records. It automates inventory tracking, tracks online/offline agent status, and keeps hardware telemetry up-to-date across your mapped companies.

## Overview & Capabilities

- **Account Mapping**: Map your Action1 organisation to one or more Weavestream companies.
- **Automated Ingestion**: Ingests Windows build details, agent status, and hardware components (CPU, RAM, storage).
- **Scheduled & On-Demand Sync**: Runs automatically on a background cron schedule or manually on demand from the Weavestream console.
- **Stale Record Tracking**: Endpoint records removed from Action1 are flagged as stale in Weavestream, keeping historical documentation intact.

## Synced Data Reference

The Action1 driver maps third-party endpoint telemetry onto fields in your chosen asset layout:

| Field | Description | Data Type |
|---|---|---|
| **Hostname** | Machine computer name | Text / String |
| **OS Version** | Windows edition and build version (e.g., Windows 11 Pro 23H2) | Text |
| **Last Seen** | Last successful check-in timestamp with Action1 | Date / Timestamp |
| **Agent Status** | Current agent state (`Connected`, `Disconnected`, or `Pending Uninstall`) | Single Select / Text |
| **Hardware Details** | Hardware specifications including CPU model, installed RAM capacity, and disk volumes | Text / Markdown |

### The Action1 section on the asset page

Each synced endpoint also shows a read-only **Action1** section on its asset page. You do not map it. It shows the live state around the facts you map, and it leaves out name, OS, platform, manufacturer, CPU, RAM, disk, serial number, IP address and MAC address:

| Group | Contents |
|---|---|
| **Status** | Agent status (connected, disconnected, pending uninstall), check-in (within 7 days, 8 to 30 days ago, over 30 days ago), last seen, last boot, reboot pending, logged-in user (account name only), agent version, agent install date, subscription (only when not active), device name (only when it differs from the endpoint name) |
| **Security** | Number of critical and other vulnerabilities. Without counts, Action1's vulnerability status |
| **Updates** | Number of critical and other missing updates. Without counts, Action1's update status |
| **Hardware detail** | Architecture, video card, network adapter, Wi-Fi adapter |
| **Active Directory** | Organizational unit and security groups |

A group with no data is not shown. The section comes from the endpoint record that each sync already reads, so it adds no request to Action1. It does not show custom attributes, the endpoint comment, installed software, or the names of missing updates and vulnerabilities.

Action1 recommends fewer than 30 API requests per minute per Action1 enterprise, and it counts all API use of the enterprise ([How Action1 API Works](https://www.action1.com/api-documentation/how-action1-api-works/)). Weavestream sends at most 24 requests per minute per API client, so a large sync takes longer: each organization needs one request for a token plus one request per 200 endpoints. Use one Action1 integration (one API client) per Action1 enterprise. A second integration, or your own scripts on the same enterprise, use the same budget. When Action1 answers "too many requests", Weavestream holds all requests of that client for the time Action1 asks, and retries the page later.

Weavestream uses one access token for all pages of one organization in one sync. A token is never used again after you save new credentials or change the API base URL.

## Setup Instructions

The **Credentials & schedule** tab shows the same steps as a setup guide. Press **Check setup** there to verify steps 1 to 3. It does not check company mappings (step 4).

### Prerequisites

- An Action1 account with permission to create API credentials.
- The region of your Action1 account.

### Step 1: Create read-only API credentials in Action1

1. In the Action1 console, open **Configuration | Users & API Credentials**.
2. Press **+ New API Credentials**.
3. Enter a name, for example `Weavestream`.
4. Select the **Enterprise Viewer** role. It is a built-in read-only role that can see endpoints in every organization. Weavestream only reads from Action1.
5. Copy the **Client ID** and the **Client Secret**. Action1 shows the secret only until you close the pop-up.

See Action1's [API credentials](https://www.action1.com/api-documentation/api-credentials/) and [Users and Roles](https://www.action1.com/documentation/users-and-roles/) pages.

### Step 2: Pick the API base URL for your region

Each Action1 account lives in one region, and its credentials work only there. Use the API base URL of that region:

| Region | API base URL |
|---|---|
| North America (default) | `https://app.action1.com/api/3.0` |
| North America 2 | `https://app.na-2.action1.com/api/3.0` |
| Europe | `https://app.eu.action1.com/api/3.0` |
| United Kingdom | `https://app.uk.action1.com/api/3.0` |
| Australia | `https://app.au.action1.com/api/3.0` |

Source: the host table in Action1's [PSAction1 module](https://github.com/Action1Corp/PSAction1/blob/main/Private/Configuration/Action1.Hosts.ps1). Action1 lists its regions on [Migrating Between Regions](https://www.action1.com/documentation/migrating-between-regions/).

### Step 3: Paste the credentials into Weavestream

1. In Weavestream, open **Admin → Integrations → New Integration**.
2. Select **Action1 RMM** and enter a label (for example `Action1 Production RMM`).
3. Enter the **Client ID** and the **Client Secret**.
4. Set **API Base URL** to the URL from step 2. For North America, leave the default.
5. Select **Create**. New integrations start paused.
6. On **Credentials & schedule**, press **Test connection**, then **Check setup**.

### Step 4: Map each Action1 organization to a company

Open **Organizations** and map each Action1 organization to its Weavestream company. If an organization is missing, check that the role from step 1 covers it.

### Step 5: Map endpoint fields

Open **Endpoints fields**. Pick the asset layout, the match key (`MAC` is suggested), and the field mappings. Weavestream reads the field list from a few endpoints in the organization. If the organization has no endpoints yet, it shows a standard list.

### Step 6: Dry run, then sync

1. On **Credentials & schedule**, set **Status** to active and select **Save changes**.
2. Press **Dry run** and review the result in **Run history**.
3. Press **Run sync now** for the initial import.

### Check setup results

| Result | Step to revisit |
|---|---|
| No Client ID and Client Secret are saved | Step 3 |
| Action1 does not accept the Client ID and Client Secret (token HTTP 400, 401 or 403) | Steps 1, 2 and 3 |
| The role cannot list organizations (HTTP 403), or the credentials see no organizations | Step 1 |
| The API base URL is not valid, does not resolve, points to a private address, or is not the Action1 API (HTTP 404) | Step 2 |
| Action1 is rate limiting, returns a server error, or cannot be reached | Try again later |

Check setup never shows Action1's own error text.

## Operational & Sync Details

- **Initial Sync**: The first run fetches all active Action1 endpoints and creates corresponding asset records in the mapped company.
- **Background Sync**: Subsequent syncs run automatically based on your tenant's default cron interval (`INTEGRATION_SYNC_DEFAULT_CRON`, defaulting to every 15 minutes) or custom schedule setting.
- **Audit Logging**: Every sync execution and individual field modification is recorded in the Weavestream Audit Trail.
