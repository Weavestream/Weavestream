# Integrations

## How asset-import integrations work
<!-- aliases: integration overview | rmm sync | import devices | external inventory | connectors -->
<!-- requires: integration.manage -->

Action1, NinjaOne, UniFi, and Breeze are pull integrations. A connection stores provider credentials and configuration. Upstream organizations map to Weavestream companies. Enabled resources select target asset layouts, match keys, and field projections to create, claim, or update assets during sync runs.

Match keys claim existing unclaimed assets instead of duplicating them. Once linked, integration sync records preserve identity across runs.

Cloudflare Zero Trust Lists manages Gateway IP lists and pushes entry changes to Cloudflare rather than importing assets.

## Create an integration
<!-- aliases: new integration | add connector | connect rmm | configure integration | integration credentials -->
<!-- requires: integration.manage -->

1. Open **Admin → Integrations**.
2. Select **New integration**.
3. Choose the driver and enter a specific **Display name**.
4. Complete configuration and credential fields.
5. Select **Create**.

New integrations start paused. On **Credentials & schedule**, select **Test connection**, finish organization and resource configuration, change **Status** to active, and select **Save changes**.

## Prepare an integration for its first sync
<!-- aliases: integration setup checklist | ready to sync | initial import | first sync -->
<!-- requires: integration.manage | sync.trigger -->

Before running an asset-import integration, confirm all of the following:

- **Credentials & schedule** shows configured credentials and **Test connection** succeeds.
- **Status** is active.
- **Organizations** contains at least one enabled company mapping.
- At least one resource has **Sync this resource on every run** enabled.
- Every enabled resource has a **Target asset layout** and at least one field projection.
- Match keys are configured when existing assets should be claimed instead of duplicated.

Save outstanding changes before starting a run.

## Configure Action1 RMM
<!-- aliases: connect action1 | action1 client id | action1 oauth | action1 endpoints -->
<!-- requires: integration.manage -->

Create an **Action1 RMM** integration using OAuth2 **Client ID** and **Client Secret** generated in Action1 (**Settings → API & Integrations**). Leave **API Base URL** at default unless a custom region is provided.

After **Test connection** succeeds, map organizations on **Organizations**. Configure **Endpoints fields** resource with layout, match keys (recommended: `MAC`), and field projections. Activate and dry-run before sync.

## Configure NinjaOne RMM
<!-- aliases: connect ninjaone | ninja rmm | ninja client id | ninjaone devices | ninja ticketing -->
<!-- requires: integration.manage -->

In NinjaOne, create an API client under **Administration → Apps → API** (monitoring scope required; ticketing scope if needed). In Weavestream, create a **NinjaOne RMM** integration with **Client ID** and **Client Secret**.

Override default US API URL for EU, CA, or OC tenants if needed. Test connection, map NinjaOne organizations to Weavestream companies, and configure **Agent devices fields** (recommended match key: `uid`) and optional **Network & non-agent devices fields**.

## Configure UniFi Site Manager
<!-- aliases: connect unifi | ubiquiti integration | unifi api key | sync switches | sync clients -->
<!-- requires: integration.manage -->

Create a **UniFi Site Manager** integration with a Site Manager **API Key**. Test connection, then map UniFi hosts/consoles to Weavestream companies.

Configure **Devices fields** for switches, access points, and gateways (recommended match: `mac`). Configure **Clients fields** separately for connected clients (recommended match: `name`).

## Configure Breeze reconstruction sync
<!-- aliases: configure Breeze reconstruction | Breeze RMM setup | Breeze Partner API | Breeze disaster recovery sync | Breeze documentation sync -->
<!-- requires: integration.manage | sync.trigger -->

1. In Breeze, create a read-only partner service principal with needed scopes (`organizations:read`, `sites:read`, `devices:read`, `inventory:read`, `configuration:read`, `scripts:read`, `backup-configuration:read`, `custom-fields:read`).
2. Issue a `brz_sp_...` key and store it in **Partner API key**. Set **Breeze URL** to the public Breeze origin.
3. Select **Test connection**, open **Organizations**, and map Breeze organization UUIDs to Weavestream companies.
4. Configure resource destinations (assets, IPAM, versioned articles, relations).
5. Set field rules (**Source wins**, **Preserve manual**, **Manual only**). Breeze sync never overwrites manual articles, relations, notes, uploads, or passwords.
6. Run a **Dry run**, inspect run history and gaps, then run an incremental or full sync.

Use **Completeness** tab to track synchronized current, manually documented, secret blocked, missing, stale, and sync error states. Blank schedules default to every 15 minutes. See `docs/integrations/breeze.md` for details.

## Configure Cloudflare Zero Trust Lists
<!-- aliases: connect cloudflare | cloudflare gateway list | zero trust ip list | register cloudflare list | register cloudflare gateway ip list -->
<!-- requires: integration.manage -->

Create a **Cloudflare Zero Trust Lists** integration using **Cloudflare Account ID** and an **API Token** scoped to **Account → Zero Trust → Edit**.

After **Test connection** succeeds, save and activate. Open **Registered lists**, select **Register list**, and choose an IP list from Cloudflare. Existing entries import upon registration. Open registered list to manage IP/CIDR entries with Weavestream as source of truth.

## Manage a registered Cloudflare Gateway IP list
<!-- aliases: cloudflare list entries | add IP to Cloudflare list | remove IP from zero trust list | CIDR allow list | cloudflare drift repair -->
<!-- requires: integration.manage -->

Open **Admin → Integrations**, select Cloudflare integration, and open **Registered lists**. Registering imports current entries and sets Weavestream as source of truth.

Open a registered list to add, edit, or remove IP/CIDR entries with descriptive comments. Changes push to Cloudflare; scheduled drift sweeps repair out-of-band Cloudflare changes back to desired state.

## Preview with a dry run
<!-- aliases: dry run | preview sync | test import | check conflicts | sync without changes -->
<!-- requires: sync.trigger -->

1. Open **Admin → Integrations** and select the integration.
2. On **Credentials & schedule**, find **Run sync**.
3. Select **Dry run**.
4. Open **Run history** to review per-company totals, conflicts, and errors.

A dry run fetches and evaluates upstream records without creating, claiming, or updating assets. Resolve match-key conflicts before a real import.

## Run a manual sync
<!-- aliases: run sync now | sync integration | import devices now | manual import -->
<!-- requires: sync.trigger -->

On **Credentials & schedule**, select **Run sync now**. Runs cover enabled organization mappings and resources in the background; track status in **Run history**.

Records are created on first run, claimed when match keys identify an eligible asset, and updated on later runs. Upstream removal does not hard-delete Weavestream history.

## Schedule automatic syncs
<!-- aliases: sync schedule | cron | automatic import | run imports automatically | every six hours | recurring sync | background sync -->
<!-- requires: integration.manage -->

1. Open integration’s **Credentials & schedule** tab.
2. Pick a **Sync schedule** interval (presets from 5 minutes to 24 hours). Intervals of 1 hour or more fire at fixed UTC times.
3. Ensure **Status** is active and save changes.

**Inherit global default** follows `INTEGRATION_SYNC_DEFAULT_CRON` (default: 15 minutes; set to `off` to disable). Custom cron expressions remain supported. For Cloudflare, this configures the **Drift sweep schedule**.

## Review run history and failures
<!-- aliases: run history | sync errors | sync conflicts | failed import | troubleshoot sync | company results -->
<!-- requires: integration.manage -->

Open the integration and select **Run history**. View status and totals per run/company for created, updated, claimed, skipped, conflicted, and failed records.

Troubleshoot by using **Test connection** for credentials and **Dry run** for mappings. Check for missing credentials, paused status, unmapped organizations, or unconfigured resource layouts/projections.

## Browse connected helpdesk tickets
<!-- aliases: tickets | NinjaOne tickets | helpdesk tickets | ticket browser | draft article from ticket | ticket search -->
<!-- requires: tickets.read.global -->

When a configured integration supplies ticketing data, open **Admin → Tickets** to browse live tickets across mapped companies. Use the available status, priority, board, company, and text filters to narrow the list, then open a ticket for its current provider data. An unmapped upstream client may be shown as unmapped rather than silently assigned to a company.

Tickets are live integration data, not imported Weavestream records. They do not create an asset or article by themselves. Open a ticket and use it as AI context only when your organization authorizes sharing its body and internal notes with the configured AI provider. The intended workflow is to ask AI to draft a knowledge-base article from a resolved ticket, then review and save the draft as an article in the correct company and visibility scope.
