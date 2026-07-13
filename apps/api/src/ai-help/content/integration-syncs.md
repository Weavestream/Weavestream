# Integration syncs

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

## Preview with a dry run
<!-- aliases: dry run | preview sync | test import | check conflicts | sync without changes -->
<!-- requires: sync.trigger -->

1. Open **Admin → Integrations** and select an Action1, NinjaOne, or UniFi integration.
2. On **Credentials & schedule**, find **Run sync**.
3. Select **Dry run**.
4. Open **Run history** to review per-company totals, conflicts, and errors.

A dry run fetches and evaluates upstream records without creating, claiming, or updating assets. Resolve ambiguous match-key conflicts or mapping errors before running a real import.

## Run a manual sync
<!-- aliases: run sync now | sync integration | import devices now | manual import -->
<!-- requires: sync.trigger -->

On **Credentials & schedule**, select **Run sync now**. The run covers every enabled organization mapping and each enabled, fully configured resource. It executes in the background; use **Run history** to follow its outcome.

Records are created on their first run, claimed when match keys identify one eligible existing asset, and updated on later runs through their integration link. Removing an upstream record does not immediately hard-delete its Weavestream history.

## Schedule automatic syncs
<!-- aliases: sync schedule | cron | automatic import | run imports automatically | every six hours | recurring sync | background sync -->
<!-- requires: integration.manage -->

1. Open the integration’s **Credentials & schedule** tab.
2. Enter a five-field UTC expression in **Sync schedule (cron)**. For example, `0 */6 * * *` runs every six hours.
3. Ensure **Status** is active.
4. Select **Save changes**.

Leave the cron field blank for manual-only syncs. Cloudflare security integrations label this setting **Drift sweep schedule (cron)**; each sweep checks registered lists and repairs drift from Weavestream’s desired state.

## Review run history and failures
<!-- aliases: run history | sync errors | sync conflicts | failed import | troubleshoot sync | company results -->
<!-- requires: integration.manage -->

Open the integration and select **Run history**. Each run shows its status and totals; open a run or company result to inspect created, updated, claimed, skipped, conflicted, and failed records.

Common setup causes include missing credentials, a paused integration, no enabled organization mappings, a resource without a target layout, no field projections, or ambiguous match-key results. Use **Test connection** for credential/provider reachability and **Dry run** after changing mappings. The chat help tool cannot inspect a specific run or the live integration state; use the displayed run details for that diagnosis.
