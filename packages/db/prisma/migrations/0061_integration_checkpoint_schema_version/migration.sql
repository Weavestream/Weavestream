-- Mid-traversal checkpoints pin the wire schema version of the pages already
-- written under the in-flight snapshot; NULL (terminal checkpoints and rows
-- predating this column) means "not pinned" and resume enforces nothing.
ALTER TABLE "integration_sync_checkpoints"
  ADD COLUMN "schema_version" VARCHAR(32);
