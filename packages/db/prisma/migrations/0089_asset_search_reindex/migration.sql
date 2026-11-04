-- Asset search text: queue a one-time rebuild of every asset's
-- `search_index` row. NUMBER, DATE, DATETIME, FILE (file names) and
-- TAGS (tag names) fields are now part of the indexed text, so the
-- asset list search and global search find a numeric serial number,
-- a date, a file or a tag. Rows written before that do not hold this
-- text, so search misses it until each asset is saved again.
--
-- The index text is built in TypeScript (`SearchIndexService`), so SQL
-- cannot redo the work here. This leaves a marker instead;
-- SearchRefreshService sees it on boot and rebuilds every asset in the
-- background (each rebuild takes the asset row lock, so live edits are
-- safe). The api runs an early pass and keeps the marker, because the
-- previous worker can still write synced assets with the old index
-- code until it is replaced; the new worker starts after that, runs
-- the final pass and drops the marker. A failed run keeps the marker
-- and resumes on the next boot. No assets (a new instance, the shadow
-- database): no marker, so the schema stays identical to schema.prisma.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "assets") THEN
    CREATE TABLE IF NOT EXISTS "pending_asset_search_reindex" (
      "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  END IF;
END $$;
