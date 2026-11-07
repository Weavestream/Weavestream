-- Integration sync robustness, phase 2 (additive only; nothing changes at deploy).
--
-- `version_hold`: the source reported a schema version Weavestream does not
--   know. The resource wrote and archived nothing and waits for an operator.
--   { since, version } with a sanitized version label, never source data.
-- `accepted_source_version`: the version an operator accepted with an
--   accepting run (integration.manage; audited as
--   integration.sync.accept_source_changes). Later runs read it without a hold.
ALTER TABLE "integration_sync_checkpoints"
    ADD COLUMN "version_hold" JSONB,
    ADD COLUMN "accepted_source_version" VARCHAR(32);
