# Integrations

## How asset-import integrations work
<!-- aliases: integration overview | rmm sync | import devices | external inventory | connectors -->
<!-- requires: integration.manage -->

Action1, NinjaOne, UniFi, Google Workspace, Microsoft 365, Level RMM, and Breeze are pull integrations. A connection stores provider credentials and configuration. Upstream organizations map to Weavestream companies. Enabled resources select target asset layouts, match keys, and field projections to create, claim, or update assets during sync runs.

Match keys claim existing unclaimed assets instead of duplicating them. Once linked, integration sync records preserve identity across runs.

Cloudflare does not import assets. It has two independent features: it manages Zero Trust Gateway IP lists and pushes entry changes to Cloudflare, and it can sync every domain on the Cloudflare account into Domains.

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

## Configure Google Workspace
<!-- aliases: connect google workspace | google oauth app | connect with google | g suite | gsuite | google admin | check setup | google client id | google redirect uri | unverified app -->
<!-- requires: settings.manage | integration.manage -->

Google Workspace is read-only and connects with OAuth. There is one Google Workspace integration per Weavestream install; each customer tenant is a connection on its **Connections** tab.

Once per Weavestream install, an administrator creates a Google Cloud project, enables the Admin SDK API and Enterprise License Manager API, sets up the consent screen (Branding, then Audience **External** and **Publish app** so it is **In production**), adds the scopes under **Data Access**, and creates a **Web application** OAuth client with the redirect URI shown in Weavestream. Create the Google Workspace integration once (**New integration → Google Workspace**; a second one is refused), open its **App** tab, paste the Client ID and Client secret, select **Save OAuth app**, then **Check setup**. The App tab shows a numbered setup guide with copy buttons; passed steps turn green and a failed step shows what to fix.

Per customer: open the Google Workspace integration, go to **Connections**, select **Connect a client** and sign in with the customer's super admin (or a delegated admin with read access). On "Google hasn't verified this app", select **Advanced**, then **Go to Weavestream (unsafe)**: expected for a self-hosted app. If the customer blocks third-party apps, they mark the Client ID **Trusted** under **Security → Access and data control → API controls**. Then map the tenant under **Organizations**, choose layouts and match fields under **Map layouts**, and run a dry run. Below the match picker, **Map layouts** lists each resource's standard facts: job title, department and phone for users; model, operating system, MAC and IP address for Chrome devices; model, manufacturer, operating system, IMEI and Wi-Fi MAC for phones; description for groups; primary domain for the tenant. Domains are not a resource: the tenant's verified domains and aliases go to the company's **Domains** monitoring on every real sync, matched to existing domains by name (never duplicated; Cloudflare details are kept), with Google's default `test-google-a.com` domains skipped. Each is set to a fitting layout field, **Create field** or **Don't sync**. Those facts fill the layout fields; the **Google Workspace** section keeps the rest: org unit, account status, licences, mailbox and Drive storage, admin role, 2-step verification, device status, last sync and last user (shown only, never assigned). A mapped field someone changed in Weavestream is never overwritten: it shows under **Differences** on the asset and on the integration's **Differences** tab, with **Use Google Workspace value** or **Keep ours**.

Do not leave the app in **Testing**: connections expire after 7 days. A connection shows **needs reconnect** when access was revoked or unused for 6 months; **Reconnect** on its row only accepts the same tenant. **Disconnect** removes one tenant. Google gives no invoices, purchased seats or renewal dates for direct customers, and usage figures lag 1 to 3 days.

## Configure Microsoft 365
<!-- aliases: connect microsoft 365 | office 365 | m365 | o365 | entra | azure ad | admin consent | connect with microsoft | microsoft app | intune | client secret expiry | concealed names | report names -->
<!-- requires: settings.manage | integration.manage -->

Microsoft 365 is read-only and connects by admin consent. There is one Microsoft 365 integration per Weavestream install; each customer tenant is a connection on its **Connections** tab.

Once per Weavestream install, an administrator registers one app in their own Microsoft Entra tenant (**Entra ID → App registrations → New registration**), with **Accounts in any organizational directory (Multitenant)** and the **Web** redirect URI shown in Weavestream. Under **API permissions → Microsoft Graph → Application permissions** they add exactly the listed permissions (each has a copy button), then create a client secret under **Certificates & secrets** and note its **Expires** date. Paste the **Application (client) ID**, the secret **Value**, the expiry date and optionally the **Directory (tenant) ID** into the **App** tab of the Microsoft 365 integration (create it once with **New integration → Microsoft 365**), select **Save Microsoft app**, then **Check setup**. Weavestream warns from 30 days before the secret expires.

Per customer: open the Microsoft 365 integration, go to **Connections** and select **Connect a client**. A **Global Administrator** or **Privileged Role Administrator** of the customer tenant must approve (a Cloud Application Administrator cannot grant Graph application permissions); the app shows as unverified, which is expected. Weavestream then adds the tenant as a row. If permissions are missing, **Check setup** lists them and a Global Administrator presses **Reconnect**.

Selecting a tenant's row on **Connections** reads that tenant's setting **Microsoft 365 admin center → Settings → Org settings → Services → Reports → "Conceal user, group, and site names in all reports"** and asks whether to show real names so mailbox and OneDrive storage can be matched to people. **Yes** turns that tenant-wide setting off once (every usage report of the tenant then shows names to anyone who can read reports, and to Weavestream); **No** changes nothing; **Turn concealment back on** reverses it. Each choice needs a step-up and is audited. This is the only change Weavestream can make in a tenant.

Map the tenant under **Organizations** and pick layouts under **Map layouts**: Users to People (match on email: mail, else user principal name), Groups to Distribution Lists, Computers (Intune Windows/macOS/Linux) to Workstations, Mobile devices (Intune iOS/Android) to Phones, and the Tenant. Last sign-in and MFA need Entra ID P1, devices need Intune, alerts need a Defender licence; without them the rows say **Not available**. Verified domains (not `*.onmicrosoft.com`) go to **Domains** monitoring, matched by name like Google's. Microsoft gives no invoices, and usage reports lag 24 to 72 hours.

## Configure Level RMM
<!-- aliases: connect level | level rmm | level.io | level api key | level devices | level groups -->
<!-- requires: integration.manage -->

Level is read-only and connects with an API key. One integration is one Level account. In Level, open **Settings → API keys**, select **Create API key**, and choose **Read-only** access. In Weavestream, select **New integration → Level RMM**, paste the key into **API key** on **Credentials & schedule**, save, then select **Test connection** and **Check setup**.

Under **Organizations**, each top-level Level group maps to one company; devices in nested groups sync with their top-level group, and devices in no group are not synced. Under **Map layouts**, pick the device layout and match on **Serial number**. Devices without a serial number (often virtual machines) are created and stay linked by their Level id. Below the match picker, **Map layouts** lists the standard facts (hostname, manufacturer, model, operating system, CPU, RAM, storage, MAC address, IP address, role): each is set to a fitting layout field, **Create field** or **Don't sync**. Those facts fill the layout fields; the **Level RMM** section on the asset keeps the rest: status, storage per partition, network, security with OS end of life, available patches, active alerts and memory and disk detail. A mapped field someone changed in Weavestream is never overwritten: it shows under **Differences** at the bottom of the Level RMM section and on the integration's **Differences** tab, with **Use Level RMM value** (write it now and follow Level again) or **Keep ours** (stop flagging it until the Level value changes). Resolving needs permission to edit assets in that company. If the key or plan cannot read alerts or patches, those groups say **Not available** and devices still sync. Level does not provide installed software, agent version or warranty dates.

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

## Configure the Cloudflare integration
<!-- aliases: connect cloudflare | cloudflare gateway list | zero trust ip list | register cloudflare list | register cloudflare gateway ip list | cloudflare domains | cloudflare registrar sync -->
<!-- requires: integration.manage -->

Create a **Cloudflare** integration using the **Cloudflare Account ID** and an **API Token**. Give the token only the permissions of the features you use: **Account → Zero Trust → Edit** for Gateway IP lists, and **Zone → Zone → Read** plus read access to **Registrar** for domain sync.

After **Test connection** succeeds, save and activate. For IP lists, open the **Lists** tab, select **Register list**, and choose an IP list from Cloudflare. Existing entries import upon registration, and Weavestream is the source of truth from then on. For domain sync, set **Sync domains into company (slug)**; the **Domains** tab shows the latest sync and has **Sync domains now**, and **Run history** lists every manual and scheduled domain sync with its counts or error.

## Manage a registered Cloudflare Gateway IP list
<!-- aliases: cloudflare list entries | add IP to Cloudflare list | remove IP from zero trust list | CIDR allow list | cloudflare drift repair -->
<!-- requires: integration.manage -->

Open **Admin → Integrations**, select the Cloudflare integration, and open the **Lists** tab. Registering imports current entries and sets Weavestream as source of truth.

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

**Inherit global default** follows `INTEGRATION_SYNC_DEFAULT_CRON` (default: 15 minutes; set to `off` to disable). Custom cron expressions remain supported. For Cloudflare, one schedule runs the list drift check and, when it is on, the domain sync.

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
