ALTER TABLE "integration_sync_checkpoints"
  ADD COLUMN "authoritative" BOOLEAN NOT NULL DEFAULT true;
