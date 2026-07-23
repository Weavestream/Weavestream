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

## Configure Breeze reconstruction sync
<!-- aliases: configure Breeze reconstruction | Breeze RMM setup | Breeze Partner API | Breeze disaster recovery sync | Breeze documentation sync -->
<!-- requires: integration.manage | sync.trigger -->

1. In Breeze, create a read-only partner service principal with the scopes needed by the resources you will enable. A complete reconstruction uses `organizations:read`, `sites:read`, `devices:read`, `inventory:read`, `configuration:read`, `scripts:read`, `backup-configuration:read`, and `custom-fields:read`.
2. Issue a `brz_sp_...` key, copy its one-time plaintext value, and store it only in Weavestream's **Partner API key** field. Set **Breeze URL** to the public Breeze origin; Weavestream adds `/api/v1/partner-api` paths (requires the July 2026 Breeze release or newer).
3. Select **Test connection**, then open **Organizations**. Map each Breeze organization UUID explicitly to one Weavestream company. Unmapped organizations are listed but never write company data.
4. Review the resource tabs and recommended native destinations. Sites, devices, inventory, software, network equipment, and virtual machines use structured assets. Scalar custom-field values page independently from definitions and update their explicitly bound device while retaining the supplied value UUID as provenance identity. Networks use IPAM; policies, scripts, automations, backup configurations, and definitions use internal versioned articles; dependencies use relations.
5. Keep source-owned fields as **Source wins**, operator-editable fields as **Preserve manual**, and local-only fields as **Manual only**. Breeze sync does not overwrite manual articles, relations, notes, uploads, or password references.
6. Run a **Dry run**, inspect run history and reconstruction gaps, then run an incremental or full sync. A full sync marks unseen Breeze-owned bindings stale only after every page succeeds; a returned record restores its original native target.

Blank schedules inherit the workspace default of every 15 minutes. Scheduled runs use a recent successful full checkpoint when possible and otherwise perform a full traversal; manual runs can select incremental or full mode. Credential, schema, cursor, rate-limit, timeout, cancellation, and partial-page failures preserve the last committed checkpoint and never authorize a stale sweep.

Use **Completeness** (Breeze reconstruction resources only; asset-import drivers such as NinjaOne or Action1 are not scored) to distinguish synchronized current, manually documented, secret blocked, missing, stale, and synchronization error. Secret-bearing definitions are represented only by safe gaps; rejected values and raw source records are not stored. Company export and PDF include the local reconstruction dossier so it remains usable when Breeze is unavailable. See the operator guide at `docs/integrations/breeze.md` for key rotation, private-network allowlisting, backup, limits, and recovery.

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
2. Pick an interval in **Sync schedule** — presets range from every 5 minutes to every 24 hours. Intervals of an hour or more fire at fixed UTC times; for example, every 6 hours runs at 00:00, 06:00, 12:00, and 18:00 UTC.
3. Ensure **Status** is active.
4. Select **Save changes**.

Leave the schedule on **Inherit global default** to follow `INTEGRATION_SYNC_DEFAULT_CRON`, which defaults to every 15 minutes. To make inherited schedules manual-only, an administrator must set the global default to `off`. A schedule saved earlier as a hand-written cron expression appears as **Custom** with its exact expression and keeps working until a preset replaces it. Cloudflare security integrations label this setting **Drift sweep schedule**; each sweep checks registered lists and repairs drift from Weavestream’s desired state.

## Review run history and failures
<!-- aliases: run history | sync errors | sync conflicts | failed import | troubleshoot sync | company results -->
<!-- requires: integration.manage -->

Open the integration and select **Run history**. Each run shows its status and totals; open a run or company result to inspect created, updated, claimed, skipped, conflicted, and failed records.

Common setup causes include missing credentials, a paused integration, no enabled organization mappings, a resource without a target layout, no field projections, or ambiguous match-key results. Use **Test connection** for credential/provider reachability and **Dry run** after changing mappings. The chat help tool cannot inspect a specific run or the live integration state; use the displayed run details for that diagnosis.
