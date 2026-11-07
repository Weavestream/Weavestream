-- Integration sync robustness, phase 1 (additive only; nothing changes at deploy).
--
-- `missed_at`: when a full traversal last did not see this binding. A binding
-- is archived only on a second miss at least 12 hours after the first, with no
-- sighting in between. Existing rows start NULL, so the first full run after
-- the upgrade only records misses and archives nothing.
ALTER TABLE "integration_sync_records"
    ADD COLUMN "missed_at" TIMESTAMP(3);

-- Per (mapping, resource, mode) checkpoint:
--   `field_presence`: baseline of how often each source field Weavestream
--     reads was present, from the last clean traversal (key paths and counts,
--     never values).
--   `field_hold`: the source stopped sending a field that was always present;
--     affected pages wrote nothing.
--   `removal_hold`: a full traversal would have archived too many records at
--     once; nothing was archived.
-- Holds clear on a clean run or when an operator accepts the source changes.
ALTER TABLE "integration_sync_checkpoints"
    ADD COLUMN "field_presence" JSONB,
    ADD COLUMN "field_hold" JSONB,
    ADD COLUMN "removal_hold" JSONB;

-- A manual run that accepts held source changes (operator with
-- integration.manage; audited as integration.sync.accept_source_changes).
ALTER TABLE "integration_sync_runs"
    ADD COLUMN "accept_source_changes" BOOLEAN NOT NULL DEFAULT false;
