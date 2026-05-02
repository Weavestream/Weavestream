-- Phase 11.2 — allow a single Asset to be linked to multiple
-- integrations simultaneously (e.g. an Action1 endpoint + a UniFi
-- client representing the same physical machine).
--
-- Background:
--   The original design pinned `IntegrationSyncRecord.asset_id` as
--   UNIQUE so each asset was owned by at most one integration. In
--   practice operators want cross-integration matching: a UniFi
--   sync should be able to claim an existing Action1-owned asset
--   when the match-key (e.g. IP address) lines up, instead of
--   creating a duplicate row. The (mapping, resource, externalId)
--   uniqueness still prevents the same integration from creating
--   duplicate sync records for the same external row.
--
-- This migration:
--   1) Drops the unique constraint on `asset_id`.
--   2) Adds a non-unique B-tree index on `asset_id` so the runner's
--      "is the asset still owned by anyone?" lookup stays cheap.

DROP INDEX IF EXISTS "integration_sync_records_asset_id_key";

CREATE INDEX "integration_sync_records_asset_id_idx"
    ON "integration_sync_records" ("asset_id");
