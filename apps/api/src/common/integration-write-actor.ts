/**
 * Actor stamped on `createdBy` / `updatedBy` by reconstruction writes.
 *
 * A sync has no human author. These paths used to stamp
 * `input.auditActorId`, which resolves to
 * `run.triggeredBy ?? run.integration.createdBy`. On a *scheduled* run
 * `triggeredBy` is null, so the column recorded whoever created the
 * integration and every surface reported "updated by <that person>" for
 * work nobody did.
 *
 * Clearing the column does not weaken accountability. The audit row
 * still carries the resolved actor, and `assertIntegrationActor` still
 * proves the sync may only write what a permitted user could write. Only
 * the display column changes, and every actor render site already omits
 * its by-line when the actor is null.
 *
 * The audit trail remains the way to attribute a machine write to an
 * integration: `integration.asset.updated` and its siblings carry
 * `integrationId`.
 */
export const INTEGRATION_WRITE_ACTOR = null;
