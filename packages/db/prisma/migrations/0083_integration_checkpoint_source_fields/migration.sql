-- Field mappings: the source field keys each complete sync traversal
-- received, so a mapped key the source stopped sending can be flagged.
-- Empty means unknown; nothing is flagged until the next complete sync.
ALTER TABLE "integration_sync_checkpoints"
    ADD COLUMN "source_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
