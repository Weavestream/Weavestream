-- Existing deployments may already have overlapping scheduled work from
-- distinct scheduler occurrences. Preserve running work first (preferring a
-- full when multiple runs are already running), then the oldest queued run,
-- and close the excess backlog before adding the guard. Manual incrementals
-- remain intentionally independent.
WITH ranked_active_flights AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "integration_id"
           ORDER BY CASE WHEN "status" = 'running' THEN 0 ELSE 1 END,
                    CASE WHEN "mode" = 'full' THEN 0 ELSE 1 END,
                    "created_at" ASC,
                    "id" ASC
         ) AS position
  FROM "integration_sync_runs"
  WHERE ("kind" = 'scheduled' OR "mode" = 'full')
    AND "status" IN ('queued', 'running')
)
UPDATE "integration_sync_runs" AS run
SET "status" = 'cancelled',
    "finished_at" = COALESCE(run."finished_at", CURRENT_TIMESTAMP),
    "error" = COALESCE(
      run."error",
      'Coalesced by scheduled single-flight migration.'
    )
FROM ranked_active_flights AS ranked
WHERE run."id" = ranked."id" AND ranked.position > 1;

CREATE UNIQUE INDEX "integration_sync_runs_one_active_scheduled_or_full_per_integration"
  ON "integration_sync_runs"("integration_id")
  WHERE ("kind" = 'scheduled' OR "mode" = 'full')
    AND "status" IN ('queued', 'running');
