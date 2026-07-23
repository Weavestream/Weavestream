---
label: NinjaOne
icon: plug
description: Connect NinjaOne RMM to sync workstations, servers, network gear, and virtual machines.
---

# NinjaOne Integration

**NinjaOne** is a unified remote monitoring and management (RMM) platform for workstations, servers, network hardware, and virtual machines.

The Weavestream NinjaOne driver imports detailed device records from your NinjaOne organisations into asset records in mapped tenants. Designed for Managed Service Providers (MSPs) and multi-tenant IT teams, a single NinjaOne integration account can fan out across multiple Weavestream companies while maintaining strict multi-tenant data isolation.

## Key Capabilities

- **Dual-Resource Architecture**: Supports separate resource configurations for agented endpoints and agentless/network devices.
- **Multi-Tenant Fan-Out**: Map individual NinjaOne organisations to distinct Weavestream companies, with optional location-based filtering.
- **Dynamic Custom Field Discovery**: Automatically discovers and exposes custom fields configured in your NinjaOne tenant alongside the standard field catalogue.
- **Stable GUID Matching**: Recommended `uid` match key ensures stable asset tracking even when hostnames, IP addresses, or MAC addresses change.
- **Real-Time AI Ticket Integration**: Integrates NinjaOne ticket bodies and internal notes into Weavestream's AI Chat workspace assistant.

## Dual-Resource Model

The NinjaOne driver exposes two independent **resources**, allowing you to route different device types into dedicated asset layouts:

| Resource | Scope & Included Devices | Recommended Asset Layout |
|---|---|---|
| **Agent Devices** (`records`) | Workstations and servers running the NinjaOne agent (Windows, macOS, Linux). | `Computers` or `Endpoints` layout — maps full agent-reported data (OS, hardware, CPU, RAM, disks, warranty, owner). |
| **Network & Non-Agent Devices** (`nms`) | NMS-discovered switches, firewalls, printers, VoIP gear, plus VMware / Hyper-V / Xen guest VMs and hypervisor management nodes. | `Network Devices` or `Virtual Machines` layout — maps network identity, IP/MAC, location, and parent relationships. |

> [!TIP]
> The **Agent Devices** resource is enabled by default. The **Network & Non-Agent Devices** resource is optional — leave it unconfigured to ignore non-agent devices, or configure it with a separate layout to track network inventory in parallel.

## Synced Data Reference

The NinjaOne driver flattens upstream `/v2/devices-detailed` responses into structured, mappable asset fields:

| Category | Available Mappable Fields |
|---|---|
| **Identity** | System name, DNS name, NetBIOS name, display name, device UID (GUID), node class, device type, tags |
| **Operating System** | OS name, manufacturer, architecture, build number, release ID, language, locale, last boot time, needs-reboot flag |
| **Hardware** | Make, model, serial number, BIOS serial, asset serial, chassis type, domain, virtual-machine flag |
| **Processor** | Processor name, architecture, core count, logical core count, clock speed (raw Hz + formatted GHz) |
| **Memory** | Total capacity in raw bytes + human-readable size (e.g., `16.0 GB`, `128.0 GB`) |
| **Volumes** | Per-volume count, primary volume details, and a multi-line formatted summary covering all storage volumes |
| **Network** | Public IP, primary IP address, primary MAC address, full IP and MAC arrays |
| **Location** | Location name, address, description |
| **Organisation** | Source NinjaOne organisation name and description |
| **Role & Policy** | Assigned role name, policy name, role-policy combination name, parent policy IDs |
| **Warranty** | Warranty start date, warranty end date, manufacturer fulfilment date |
| **Assigned Owner** | Owner name, email address, phone number, user type, invitation status |
| **Maintenance** | Maintenance mode status, scheduled start/end times, maintenance reason |
| **Lifecycle** | Created timestamp, last contact timestamp, last update timestamp, approval status, offline state |

## Match Key Recommendations

When configuring resource mappings, choose a **Match Key** that uniquely identifies device records:

- **Device UID (`uid`)** *(Recommended)*: NinjaOne's stable GUID. Remains unchanged across IP address, MAC address, hostname, or domain changes.
- **System Name (`systemName`)**: Suitable when hostnames are guaranteed unique across your environment.

## Setup Guide

### Step 1: Create an API Client in NinjaOne
1. In NinjaOne, go to **Administration → Apps → API**.
2. Click **Add API Client**.
3. Set Client Type to **Client Credentials (Client ID/Secret)**.
4. Select the **Monitoring** scope.
5. Save the client and securely record the **Client ID** and **Client Secret**.

### Step 2: Add the Integration in Weavestream
1. In Weavestream, navigate to **Admin → Integrations → New Integration**.
2. Select **NinjaOne RMM** as the provider.
3. Enter your **Client ID** and **Client Secret**.
4. Set the **API Base URL** according to your NinjaOne regional instance:
   - North America / US: `https://app.ninjarmm.com`
   - Europe / EU: `https://eu.ninjarmm.com`
   - Canada / CA: `https://ca.ninjarmm.com`
   - Oceania / OC: `https://oc.ninjarmm.com`
5. Click **Test Connection** to verify credential validity.

### Step 3: Map Organisations & Configure Resources
1. Click the **Orgs** tab.
2. Select a NinjaOne organisation and map it to its corresponding **Weavestream Company**.
3. *(Optional)* Filter by Location ID if you only want to ingest devices from specific sites.
4. Switch to the **Agent Devices** resource tab:
   - Pick the target asset layout (e.g., `Computers`).
   - Select the match key (`uid` recommended).
   - Configure field mappings. The field list populates live from a sample of your NinjaOne devices.
5. *(Optional)* Switch to the **Network & Non-Agent Devices** tab to configure non-agent/NMS devices with a dedicated layout (e.g., `Network Devices`).
6. Click **Save & Sync** to initiate the initial synchronization.

## AI & Ticket Integration

If configured alongside ticketing, Weavestream's **AI Chat** can retrieve live ticket details and internal notes from NinjaOne when answering user queries about tenant devices or maintenance history.
