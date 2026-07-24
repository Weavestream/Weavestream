ALTER TABLE "integration_sync_runs"
  ADD COLUMN "mode" "IntegrationSyncMode" NOT NULL DEFAULT 'incremental';

CREATE UNIQUE INDEX "integration_sync_runs_one_active_full_per_integration"
  ON "integration_sync_runs"("integration_id")
  WHERE "mode" = 'full' AND "status" IN ('queued', 'running');
