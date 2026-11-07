-- Integration sync robustness, phase 3: early warning (additive only).
--
-- The source version each sync run saw, so an operator can see when the
-- source (for example Breeze RMM) was upgraded between two runs.
-- `source_server_version`: the server release the source reports (Breeze
--   `GET /health` `version`). `source_schema_version`: the partner API
--   schema version. Both are short sanitized labels (never response bodies),
--   NULL when the source does not report one or the read failed.
ALTER TABLE "integration_sync_runs"
    ADD COLUMN "source_server_version" VARCHAR(64),
    ADD COLUMN "source_schema_version" VARCHAR(64);
