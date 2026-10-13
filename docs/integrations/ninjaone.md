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
- **Real-Time AI Ticket Integration**: Integrates NinjaOne ticket bodies and internal notes into Weavestream's **Ask anything** assistant.

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

## Setup Instructions

The **Credentials & schedule** tab shows the same steps as a setup guide. Press **Check setup** there to verify steps 1 to 4.

### Prerequisites

- A NinjaOne account with permission to open **Administration > Apps > API**.
- The regional instance you sign in to (the host in your browser's address bar).

### Step 1: Create an API client app in NinjaOne

1. In NinjaOne, open **Administration > Apps > API** and select the **Client app IDs** tab.
2. Press **Add client app**.
3. Set **Application Platform** to **API Services (machine-to-machine)**.
4. Enter a **Name**, for example `Weavestream`. Leave **Redirect URIs** empty.
5. Under **Scopes**, select **Monitoring** only. It gives read-only access to devices and organizations. Weavestream needs no **Management** or **Control** scope.
6. Under **Allowed Grant Types**, select **Client Credentials**.
7. Press **Save**. Copy the **Client ID** and the **Client Secret**.

See NinjaOne's [Register Machine-to-Machine Applications](https://app.ninjarmm.com/apidocs-beta/authorization/create-applications/machine-to-machine-apps), [Client Credentials Flow](https://app.ninjarmm.com/apidocs-beta/authorization/flows/client-credentials-flow) and [API OAuth Token Configuration](https://www.ninjaone.com/docs/application-programming-interface-api/oauth-token-configuration/) pages.

### Step 2: Pick the API base URL for your region

Each NinjaOne account lives on one regional instance, and its client app works only there. Use the base URL of the instance you sign in to:

| Instance | API base URL |
|---|---|
| United States (default) | `https://app.ninjarmm.com` |
| United States 2 | `https://us2.ninjarmm.com` |
| Canada | `https://ca.ninjarmm.com` |
| Europe | `https://eu.ninjarmm.com` |
| Asia-Pacific Southeast (OC) | `https://oc.ninjarmm.com` |
| Japan | `https://jp.ninjarmm.com` |
| FedRAMP Moderate | `https://fed.ninjarmm.com` |

Source: NinjaOne's [How to Set Up an API Server in NinjaOne](https://www.ninjaone.com/blog/how-to-set-up-an-api-server-in-ninjaone/). That page names the second US instance only as `us2`.

### Step 3: Paste the credentials into Weavestream

1. In Weavestream, open **Admin → Integrations → New Integration**.
2. Select **NinjaOne RMM** and enter a label.
3. Enter the **Client ID** and the **Client Secret**.
4. Set **API Base URL** to the URL from step 2. For `app.ninjarmm.com`, leave the default.
5. Select **Create**. New integrations start paused.
6. On **Credentials & schedule**, press **Test connection**, then **Check setup**.

### Step 4: Map each NinjaOne organization to a company

Open **Organizations** and map each NinjaOne organization to its Weavestream company. Organizations that you do not map are not synced.

### Step 5: Map device fields

1. Open **Agent devices fields**. Pick the asset layout (for example `Computers`), the match key (`uid` is suggested), and the field mappings. Weavestream reads the field list from a few devices in the organization. If the organization has no devices yet, it shows a standard list.
2. *(Optional)* Open **Network & non-agent devices fields** to sync network gear and virtual machines into their own layout (for example `Network Devices`). Leave it empty to skip those devices.

### Step 6: Dry run, then sync

1. On **Credentials & schedule**, set **Status** to active and select **Save changes**.
2. Press **Dry run** and review the result in **Run history**.
3. Press **Run sync now** for the initial import.

### Optional: NinjaOne tickets

Weavestream reads NinjaOne tickets, read-only, with the same client app. It reads them from your NinjaOne ticket boards. If no tickets show, check that NinjaOne Ticketing is turned on and has at least one ticket board. Device sync works without it.

### Check setup results

| Result | Step to revisit |
|---|---|
| No Client ID and Client Secret are saved | Step 3 |
| NinjaOne does not accept the Client ID and Client Secret (token HTTP 400, 401 or 403) | Steps 1 and 3 |
| The client app does not have the Monitoring scope (`invalid_scope`, or HTTP 403 on the organization list) | Step 1 |
| NinjaOne does not know the Client ID at this base URL (token HTTP 404): wrong region or a mistyped Client ID | Steps 2 and 3 |
| The API base URL is not valid, does not resolve, points to a private address, or is not the NinjaOne API | Step 2 |
| The credentials work, but NinjaOne returns no organizations | Step 4 |
| NinjaOne is rate limiting, returns a server error, or cannot be reached | Try again later |

Check setup always exchanges a new token, so a cached token cannot hide a revoked client app. It never shows NinjaOne's own error text.

## AI & Ticket Integration

If configured alongside ticketing, Weavestream's **Ask anything** assistant can retrieve live ticket details and internal notes from NinjaOne when answering user queries about tenant devices or maintenance history.
