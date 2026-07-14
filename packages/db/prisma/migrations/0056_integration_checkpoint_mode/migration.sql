CREATE TYPE "IntegrationSyncMode" AS ENUM ('incremental', 'full');

ALTER TABLE "integration_sync_checkpoints"
  ADD COLUMN "mode" "IntegrationSyncMode";

UPDATE "integration_sync_checkpoints" SET "mode" = 'incremental' WHERE "mode" IS NULL;

ALTER TABLE "integration_sync_checkpoints"
  ALTER COLUMN "mode" SET DEFAULT 'incremental',
  ALTER COLUMN "mode" SET NOT NULL;

DROP INDEX "integration_sync_checkpoints_mapping_resource_key";

CREATE UNIQUE INDEX "integration_sync_checkpoints_integration_company_mapping_id_resource_id_mode_key"
  ON "integration_sync_checkpoints"("integration_company_mapping_id", "resource_id", "mode");

CREATE INDEX "integration_sync_checkpoints_resource_id_mode_last_completed_at_idx"
  ON "integration_sync_checkpoints"("resource_id", "mode", "last_completed_at");
