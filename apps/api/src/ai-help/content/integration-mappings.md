# Integration mappings

## Map an upstream organization to a company
<!-- aliases: organization mapping | org mapping | customer mapping | tenant mapping | map rmm customer | map console -->
<!-- requires: integration.manage -->

1. Open **Admin → Integrations** and select the integration.
2. Confirm credentials are configured and **Test connection** succeeds.
3. Open **Organizations** and select **Add mapping**.
4. Choose the **Upstream organization** supplied by the driver.
5. Choose the destination **Weavestream company**.
6. Select **Create mapping**.

An upstream organization can be mapped only once within the integration. Resource layout and field settings are global to the integration and automatically apply to every enabled company mapping.

## Select a resource and target asset layout
<!-- aliases: resource fields | target layout | integration layout | devices layout | endpoints layout | enable resource -->
<!-- requires: integration.manage -->

Open the integration’s resource tab, such as **Endpoints fields**, **Agent devices fields**, **Devices fields**, or **Clients fields**.

1. Enable **Sync this resource on every run** if the resource should participate.
2. Under **Target asset layout**, select the global layout into which that resource will write assets.
3. Configure match keys and field projections.
4. Select **Save changes**.

Changing or clearing a layout removes incompatible draft mappings. A resource is ready to sync only when it is enabled, has a target layout, and has at least one valid field mapping.

## Configure match keys
<!-- aliases: matching | deduplication | duplicate assets | stop imported device duplicates | imported devices duplicated | claim existing asset | unique identifier | device uid | external id -->
<!-- requires: integration.manage -->

Match keys tell an integration how to claim an existing, unclaimed asset instead of creating a duplicate.

1. Select the resource’s **Target asset layout**.
2. Under **Match keys**, select one or more layout fields that reliably identify the same record.
3. Add field projections that map the corresponding upstream values into those target fields.
4. Select **Save changes**, then use **Dry run** to review conflicts.

Text, email, and URL values match case-insensitively; other supported values match exactly. Prefer stable identifiers such as NinjaOne `uid` or a hardware MAC address over names or DHCP addresses. If several assets match, the run reports a conflict rather than guessing.

## Configure field projections
<!-- aliases: field mapping | map fields | source field | target field | sync direction | source wins | preserve manual -->
<!-- requires: integration.manage -->

On the resource tab, use **Field projections** to map upstream data into fields on the selected asset layout.

1. Select **Add row**.
2. Choose the **Source field** reported by the provider.
3. Choose a compatible **Target field** from the selected layout.
4. Choose the **Direction**. Source-controlled mappings update the field on later syncs; preserve-manual mappings keep an operator’s existing value.
5. Repeat for every value that should be imported and select **Save changes**.

At least one field projection is required before the resource can sync. Source fields are refreshed from a live provider sample when supported, so tenant-specific fields can appear alongside the built-in list.
