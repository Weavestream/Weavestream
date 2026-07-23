-- Non-participant clears used to DELETE the summary row, which also deleted
-- the scope's evaluation clock (`evaluated_at`): a slower, older recalculation
-- committing afterwards found no row and recreated a stale scorecard. Cleared
-- scorecards are now tombstoned in place (`cleared_at` set, counts emptied) so
-- the clock survives and recency guards keep working. NULL means the row is a
-- live scorecard; readers filter on it.
ALTER TABLE "integration_reconstruction_summaries"
  ADD COLUMN "cleared_at" TIMESTAMP(3);
