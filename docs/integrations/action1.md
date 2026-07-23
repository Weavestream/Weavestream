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
| **Agent Status** | Current agent state (`Online`, `Offline`, or `Pending`) | Single Select / Text |
| **Hardware Details** | Hardware specifications including CPU model, installed RAM capacity, and disk volumes | Text / Markdown |

## Setup Instructions

### Prerequisites

- An active Action1 account with administrative privileges.
- An Action1 OAuth2 **Client ID** and **Client Secret**.

### Step 1: Generate Action1 API Credentials

1. Log into your **Action1 Console**.
2. Navigate to **Settings → API & Integrations**.
3. Create OAuth2 API credentials with access to endpoint inventory.
4. Securely record the generated **Client ID** and **Client Secret**.

### Step 2: Configure the Integration in Weavestream

1. In Weavestream, navigate to **Admin → Integrations → New Integration**.
2. Select **Action1 RMM** as the integration provider.
3. Enter a descriptive label (e.g. `Action1 Production RMM`).
4. Enter the OAuth2 **Client ID** and **Client Secret**. Leave **API Base URL** at its default unless Action1 supplied a custom region.
5. Select **Create**. New integrations start paused.
6. On **Credentials & schedule**, select **Test connection**.
7. Open **Organizations** and map each Action1 organization to its target Weavestream company.
8. Configure **Endpoints fields** with a target asset layout, match keys (recommended upstream value: `MAC`), and field projections.
9. Change **Status** to active and select **Save changes**.
10. Run a **Dry run**, review its result in **Run history**, then select **Run sync now** for the initial import.

## Operational & Sync Details

- **Initial Sync**: The first run fetches all active Action1 endpoints and creates corresponding asset records in the mapped company.
- **Background Sync**: Subsequent syncs run automatically based on your tenant's default cron interval (`INTEGRATION_SYNC_DEFAULT_CRON`, defaulting to every 15 minutes) or custom schedule setting.
- **Audit Logging**: Every sync execution and individual field modification is recorded in the Weavestream Audit Trail.
