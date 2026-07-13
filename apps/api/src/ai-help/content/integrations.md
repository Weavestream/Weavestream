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
5. Optionally enter a five-field UTC cron expression under **Sync schedule (cron)**. Leave it blank for manual-only runs.
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
<!-- aliases: connect cloudflare | cloudflare gateway list | zero trust ip list | register cloudflare list -->
<!-- requires: integration.manage -->

Create a **Cloudflare Zero Trust Lists** integration using the **Cloudflare Account ID** and an **API Token** scoped to **Account → Zero Trust → Edit**. This manages Gateway IP lists, not the unrelated WAF Account Filter Lists API.

After **Test connection** succeeds, save and activate the integration. Open **Registered lists**, select **Register list**, and choose an existing IP list from the Cloudflare account. Existing entries are imported when it is registered. Open the registered list to add, edit, or remove IP/CIDR entries. Weavestream becomes the source of truth and the scheduled drift sweep corrects out-of-band Cloudflare changes.

