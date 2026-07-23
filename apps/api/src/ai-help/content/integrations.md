# Integrations

## How asset-import integrations work
<!-- aliases: integration overview | rmm sync | import devices | external inventory | connectors -->
<!-- requires: integration.manage -->

Action1, NinjaOne, and UniFi are pull integrations. A connection stores provider configuration and encrypted credentials. **Organizations** map upstream organizations or consoles to Weavestream companies. Each resource tab selects a global target asset layout, match keys, and field projections. A manual or scheduled run then creates, claims, or updates assets in every enabled company mapping.

Match keys allow an unclaimed Weavestream asset to be claimed instead of duplicated. Once an external record is linked, its integration sync record preserves that identity across later runs. One asset can be linked to more than one integration.

Cloudflare Zero Trust Lists is different: Weavestream manages registered Gateway IP lists and pushes entry changes to Cloudflare. It does not import assets.

## Create an integration
<!-- aliases: new integration | add connector | connect rmm | configure integration | integration credentials -->
<!-- requires: integration.manage -->

1. Open **Admin → Integrations**.
2. Select **New integration**.
3. Choose the driver and enter a specific **Display name**.
4. Complete the driver’s configuration and credential fields.
5. Optionally pick an interval under **Sync schedule** — presets range from every 5 minutes to every 24 hours. **Inherit global default** follows the `INTEGRATION_SYNC_DEFAULT_CRON` value, which defaults to every 15 minutes. An administrator can set that global value to `off` to disable inherited scheduled runs.
6. Select **Create**.

New integrations start paused. On **Credentials & schedule**, select **Test connection**, finish organization and resource configuration, change **Status** to active, and select **Save changes**.

## Configure Action1 RMM
<!-- aliases: connect action1 | action1 client id | action1 oauth | action1 endpoints -->
<!-- requires: integration.manage -->

Create an **Action1 RMM** integration using the OAuth2 **Client ID** and **Client Secret** generated in Action1 under **Settings → API & Integrations**. Leave **API Base URL** at its default unless Action1 supplied a custom region.

After **Test connection** succeeds, map each Action1 organization on **Organizations**. Configure the **Endpoints fields** resource with a target asset layout, match keys, and at least one field projection. The suggested upstream match value is `MAC`, but choose stable fields that correspond to the selected layout. Activate the integration and run a dry run before the first real sync.

## Configure NinjaOne RMM
<!-- aliases: connect ninjaone | ninja rmm | ninja client id | ninjaone devices | ninja ticketing -->
<!-- requires: integration.manage -->

In NinjaOne, create an API client under **Administration → Apps → API**. Grant the monitoring scope; add ticketing when the ticket browser is required. In Weavestream, create a **NinjaOne RMM** integration with its **Client ID** and **Client Secret**.

The default API URL is the US region. Override it for EU, CA, or OC NinjaOne tenants. Test the connection, then map NinjaOne organizations to Weavestream companies.

Configure **Agent devices fields** for agent-managed endpoints. Configure **Network & non-agent devices fields** only when NMS-discovered equipment or virtual systems should also be imported. Each resource can use a different layout. The recommended upstream match value is the stable `uid`.

## Configure UniFi Site Manager
<!-- aliases: connect unifi | ubiquiti integration | unifi api key | sync switches | sync clients -->
<!-- requires: integration.manage -->

Create a **UniFi Site Manager** integration with a Site Manager **API Key**. Leave **API Base URL** at the default unless UniFi supplied a different API host. Select **Test connection**, then map each visible UniFi host or console to its Weavestream company.

Configure **Devices fields** for switches, access points, gateways, and other managed network devices. Configure **Clients fields** separately for connected clients. Devices suggest `mac` as an upstream matching value; clients suggest `name`. Choose match keys that correspond to fields on the selected target layout, save the mappings, activate the integration, and dry-run it before importing.

## Configure Cloudflare Zero Trust Lists
<!-- aliases: connect cloudflare | cloudflare gateway list | zero trust ip list | register cloudflare list | register cloudflare gateway ip list -->
<!-- requires: integration.manage -->

Create a **Cloudflare Zero Trust Lists** integration using the **Cloudflare Account ID** and an **API Token** scoped to **Account → Zero Trust → Edit**. This manages Gateway IP lists, not the unrelated WAF Account Filter Lists API.

After **Test connection** succeeds, save and activate the integration. Open **Registered lists**, select **Register list**, and choose an existing IP list from the Cloudflare account. Existing entries are imported when it is registered. Open the registered list to add, edit, or remove IP/CIDR entries. Weavestream becomes the source of truth and the scheduled drift sweep corrects out-of-band Cloudflare changes.

## Manage a registered Cloudflare Gateway IP list
<!-- aliases: cloudflare list entries | add IP to Cloudflare list | remove IP from zero trust list | CIDR allow list | cloudflare drift repair -->
<!-- requires: integration.manage -->

Open **Admin → Integrations**, select the Cloudflare Zero Trust Lists integration, then open **Registered lists**. Registering a list imports its current entries and designates Weavestream as the source of truth for that registered list.

Open a registered list to add, edit, or remove an IP/CIDR entry. Use a descriptive comment when the UI provides one so another operator can identify the purpose of an address. Changes are pushed to the Cloudflare Gateway list; do not edit the same registered list directly in Cloudflare unless you intend Weavestream’s next drift sweep to restore its recorded desired state.

The list must be a Cloudflare Zero Trust/Gateway IP list, not the unrelated WAF Account Filter Lists API. A blank drift-sweep schedule inherits the global integration schedule; set an explicit cron for this integration or have an administrator set the global default to `off` when no scheduled repair is wanted.

## Browse connected helpdesk tickets
<!-- aliases: tickets | NinjaOne tickets | helpdesk tickets | ticket browser | draft article from ticket | ticket search -->
<!-- requires: tickets.read.global -->

When a configured integration supplies ticketing data, open **Admin → Tickets** to browse live tickets across mapped companies. Use the available status, priority, board, company, and text filters to narrow the list, then open a ticket for its current provider data. An unmapped upstream client may be shown as unmapped rather than silently assigned to a company.

Tickets are live integration data, not imported Weavestream records. They do not create an asset or article by themselves. Open a ticket and use it as AI context only when your organization authorizes sharing its body and internal notes with the configured AI provider. The intended workflow is to ask AI to draft a knowledge-base article from a resolved ticket, then review and save the draft as an article in the correct company and visibility scope.
