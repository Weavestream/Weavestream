---
label: Level RMM
icon: plug
description: Sync Level RMM devices per top-level group. Hardware, OS and network facts fill your layout fields; status, storage, security, patches and alerts show on the asset.
---

# Level RMM Integration

**Level RMM** is a remote monitoring and management (RMM) platform for Windows, macOS and Linux devices.

The Weavestream Level driver is **read-only**. One integration is one Level account. Each **top-level group** in Level is mapped to one Weavestream company, and its devices (including the devices of groups nested under it) sync into that company.

## Overview & Features

- **One API key per Level account**: a Read-only key is all it needs.
- **Top-level groups as organizations**: map each top-level group to a company. Nested groups sync with their top-level group.
- **Match first**: on the first sync, Level devices link to the assets you already have by **serial number**. An asset is only created when nothing matches.
- **Standard facts fill your layout fields**: hostname, manufacturer, model, operating system, CPU, RAM, storage, MAC address, IP address and role go into the layout's own fields (you pick or create them in **Map layouts**). Everything else shows in a **Level RMM** section on the asset page.
- **Your edits win**: a field someone changed in Weavestream is never overwritten. It is listed as a **difference** instead, and you choose which value to keep.
- **Built-in setup guide and Check setup**: the steps below are also shown on the integration's **Credentials & schedule** tab, and **Check setup** points to the step that needs fixing.

## Synced Data Reference

| Resource | Suggested layout | Matched on |
|---|---|---|
| **Devices** | Workstations, Computers, Servers, Devices, Configurations or Laptops (or a new **Devices** layout) | Serial number |

The asset name is the Level nickname, or the hostname when there is none. These **layout fields** are filled when you map them in **Map layouts**:

| Layout field | Value | Example |
|---|---|---|
| **Serial number** | The device serial number (the match field) | `SN-001` |
| **Hostname** | The device hostname | `ws-01` |
| **Manufacturer** | System manufacturer | `Example Corp` |
| **Model** | System model | `Book 14` |
| **Operating system** | Full OS name with version | `Windows 11 Pro 23H2` |
| **CPU** | First CPU model and total cores; several sockets show as `2x` | `Example CPU 8000 (8 cores)` |
| **RAM** | Installed memory, rounded to whole GB | `16 GB` |
| **Storage** | Each disk as size, type and model, joined with commas | `512 GB NVMe (Example SSD)` |
| **MAC address** | MAC of the primary network interface (the one with a private IP and a gateway, else the first with a MAC) | `00:11:22:33:44:55` |
| **IP address** | Primary private IPv4 address | `10.0.0.10` |
| **Role** | Level device role | `Workstation` |

A value Level does not report is left alone: the field is never cleared. Fields you own (asset tag, status, location, assigned user, purchase, warranty, notes and the like) are never written.

The **Level RMM** section on each device keeps only what a layout does not have:

| Group | Contents |
|---|---|
| **Status** | Online or offline, last seen, last reboot, logged-in user, maintenance mode, platform, the Level group (site) the device is in, and its location from IP (city, country) |
| **Storage** | One usage bar per partition (used = size minus free space), labelled by mount point |
| **Network** | Public IP, private IPs, and per network interface its MAC address, IP addresses, gateway and DNS servers |
| **Security** | Risk, OS end of life, security score, patch compliance, antivirus, firewall, encryption of the primary partition, user account control, automatic updates, admin accounts |
| **Patches** | Number of available updates and the first 20 by name |
| **Alerts** | Number of active alerts and the first 20 with severity and start time |
| **Hardware detail** | Each memory module and each disk model |
| **Tags** | Level tags |
| **Notes** | Level device notes |
| **Differences** | Fields someone changed in Weavestream that now differ from Level (see below) |

### How Level updates your fields

- **First sync of a device** (a new asset, or an existing asset it adopts): Level writes every mapped field.
- **Later syncs**: an empty field is filled. A field that still holds the value Level wrote last follows Level, so hardware and OS changes flow through.
- **A field you map later** on a device Level already syncs: an empty one is filled; one that already holds a value is listed under **Differences** instead of being overwritten.
- **A field someone changed** is not overwritten. When it differs from Level, it is listed under **Differences** at the bottom of the Level RMM section, with the Weavestream value and the Level RMM value:
  - **Use Level RMM value** writes the Level value now, and the field follows Level again.
  - **Keep ours** keeps your value and stops flagging that field on that device until the Level value changes again.
- Every open difference across all companies is also listed on the integration's **Differences** tab (**Admin > Integrations > your Level integration**), filterable by company, with the same two buttons. Tick several rows (or **Select all** matching the company filter) to resolve them in one go; the tab confirms first and then lists what was applied, skipped or failed. Resolving a difference needs permission to edit assets in that company and is recorded in the audit log. Differences are never shown to client users.

Devices **without a serial number** (common for virtual machines) are created as new assets on the first sync and stay linked by their Level device id afterwards; they cannot match an existing asset.

### What Level's API does not provide

- **Installed software.**
- **Agent version.**
- **Warranty dates.**

### Limits

- **Devices that are in no group are not synced.** Put them in a group in Level.
- **Alerts and patches need the matching Level access.** If your plan or key cannot read them, devices still sync and the group says "Not available".
- **Very large accounts.** Active alerts and available updates hold at most 50,000 entries per sync. Above that, the group says the data is not shown instead of showing a partial list.

## Setup Instructions

### Step 1: Create a read-only API key in Level

In Level, open **Settings > API keys** and press **Create API key**. Name it, for example **Weavestream**, and set the access level to **Read-only**. Copy the key. A Level key covers the whole account and does not expire, so store it safely.

### Step 2: Paste the key into Weavestream

1. Go to **Admin > Integrations > New integration** and choose **Level RMM**.
2. On the **Credentials & schedule** tab, paste the key into **API key** and save.
3. Press **Test connection**, then **Check setup** in the setup guide.

### Step 3: Map each top-level group to a company

Open **Organizations**. Every top-level group in Level is listed. Map each one to its Weavestream company.

### Step 4: Map layouts and run the first sync

1. Open **Map layouts** (see below), then set **Status** to active and save.
2. Run a **Dry run**, check **Run history**, then **Run sync now**.

## Map Layouts and Match-first

The **Map layouts** tab lists the **Devices** resource. Pick the layout devices go into (or create a new one, or skip it) and the field to match on. Weavestream suggests existing layouts by name, such as Workstations or Configurations, and a field named like Serial number. If the layout you pick has no Serial number field, choose **Create field** in the match picker and Weavestream adds that field to the layout when you save; it is pre-selected when no existing field fits.

Below the match picker, a table lists the standard facts (Hostname, Operating system, CPU, RAM, ...). Each row is pre-set to an existing layout field whose name fits (for example **Host name**, **OS** or **Memory**) and whose type can hold the value. When none fits, the row is set to **Create field**, which adds a text field with that name on save (an IP address field for IP address). Pick **Don't sync** to leave a fact out. Each layout field takes only one fact, and files, asset references and dropdown fields are never offered. A field with the same name but another type is never changed: pick another field instead. **Create new layout** and **Create field** also need permission to manage asset layouts.

On sync, a device whose serial number equals **exactly one** unlinked asset you created yourself adopts that asset instead of creating a duplicate. Text matching ignores upper and lower case. If two or more assets match, the run reports it and links nothing.

When none of your own assets match, a device also links to **exactly one** asset another integration already syncs with the same serial number (for example the laptop from Microsoft Intune). Level RMM is first in the default priority order, so its values fill that asset's standard fields; the other integration lists any value that differs under **Differences**. See [Several integrations on one asset](/integrations/#several-integrations-on-one-asset).

An adopted asset keeps the name you gave it. Assets that Level created follow the Level name.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Test connection or Check setup: "does not accept this API key" | The key is mistyped or was revoked (HTTP 401) | Create a new key (step 1) and paste it again (step 2). |
| Check setup: "has no access to devices and groups" | The key lacks access (HTTP 403) | Create a key with **Read-only** access. |
| Check setup: "rate limiting" | Level returned HTTP 429 | Wait a minute and check again. Syncs retry on their own. |
| Check setup: "no top-level groups" | No groups exist in Level | Put devices in a group in Level. |
| Sync fails with "not a top-level group of this Level account" | The mapped group was deleted, moved under another group, or belongs to another account | Map a group that is listed under **Organizations**. |
| A device is missing | It is in no group | Put it in a group in Level. |
| Patches or Alerts say "Not available" | Your plan or key cannot read updates or alerts | Use a key and plan with that access. Devices still sync. |
| A record was not linked and the run reports "multiple assets match" | Two or more of your assets share the serial number | Remove or rename the duplicates, then sync again. |
| A layout field stopped updating from Level | Someone changed it in Weavestream, so it is listed as a difference | Open the asset (or the integration's **Differences** tab) and choose **Use Level RMM value** or **Keep ours**. |
| A fact is not filled at all | It is set to **Don't sync** in **Map layouts**, or Level does not report it for that device | Map it in **Map layouts**; values Level does not report stay empty. |

## Security Model

- **Read-only.** The driver only sends GET requests to `https://api.level.io/v2`. Check setup is read-only too. A **Read-only** key is recommended.
- **Encrypted key.** The API key is encrypted at rest (AES-256-GCM), never shown again and never logged. Level expects the raw key in the `Authorization` header.
- **Tenant isolation.** A company only receives devices of the top-level group mapped to it, and only when that group is a top-level group of the connected account.
- **No raw Level errors.** Errors shown in Weavestream are fixed messages; Level's own error text is never passed through.
- **Hidden from client users.** Level sections and differences are never shown to client users, even on assets they can see.
- **Audited choices.** Resolving a difference needs permission to edit that asset's company and writes an `integration.difference.resolve` audit row (ids and the choice, never the values). A bulk action on the **Differences** tab writes one such row per difference plus an `integration.difference.resolve_bulk` summary row (counts only); differences in companies you cannot edit are skipped and listed.

Reference: [Level public API, getting started](https://docs.level.io/en/articles/12152745-public-api-getting-started) and the [Level API reference](https://developers.level.io).
