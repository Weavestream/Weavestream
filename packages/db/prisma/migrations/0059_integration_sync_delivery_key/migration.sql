ALTER TABLE "integration_sync_runs"
  ADD COLUMN "delivery_key" VARCHAR(512);

CREATE UNIQUE INDEX "integration_sync_runs_delivery_key_key"
  ON "integration_sync_runs"("delivery_key");
