ALTER TABLE "integration_sync_checkpoints"
  ADD COLUMN "authoritative" BOOLEAN NOT NULL DEFAULT true;

UPDATE "integration_sync_checkpoints"
SET "authoritative" = false
WHERE "cursor" IS NOT NULL;
