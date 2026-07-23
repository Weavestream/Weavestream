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

### Prerequisites

- A UniFi Site Manager account with access to the required hosts and sites.
- A UniFi Site Manager **API Key**.

### Step 1: Prepare Site Manager Credentials

Create a dedicated UniFi Site Manager API key with access to the hosts and sites that Weavestream should inventory. Store the key securely; Weavestream encrypts it when the integration is saved.

### Step 2: Configure Integration in Weavestream

1. In Weavestream, navigate to **Admin → Integrations → New Integration**.
2. Select **UniFi Site Manager** as the provider.
3. Enter the Site Manager **API Key**. Leave **API Base URL** at its default unless UniFi supplied a different API host.
4. Select **Create**. New integrations start paused.
5. On **Credentials & schedule**, select **Test connection**.
6. Open **Organizations** and map each visible UniFi host or console to the corresponding Weavestream company.
7. Configure **Devices fields** for gateways, switches, and access points (recommended upstream match value: `mac`).
8. Configure **Clients fields** separately for connected clients (recommended upstream match value: `name`).
9. Change **Status** to active and select **Save changes**.
10. Run a **Dry run**, review its result in **Run history**, then select **Run sync now** for the initial import.

The shipped driver uses the cloud-hosted UniFi Site Manager APIs; it does not connect directly to a local controller with a controller username and password.
