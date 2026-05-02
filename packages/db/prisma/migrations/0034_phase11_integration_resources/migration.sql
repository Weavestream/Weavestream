-- Phase 11.1 — promote per-integration globals (asset_layout_id,
-- match_key_field_ids, field mappings, sync records) into a per-RESOURCE
-- container so a single integration can fan out into multiple asset
-- layouts.
--
-- Background:
--   The Phase 11 design assumed one external-resource type per
--   integration: Action1 = endpoints, UniFi = devices. With UniFi
--   adding a second resource (clients) that needs its own asset
--   layout, the per-integration globals stop scaling — devices and
--   clients can't share a layout, so the fields/match-keys/mappings
--   need their own per-resource container.
--
-- This migration:
--   1) Creates `integration_resources` (one row per (integration,
--      resource_key) pair) and seeds one `'devices'` (UniFi) or
--      `'records'` (every other driver) row per existing integration,
--      carrying the integration's current asset_layout_id +
--      match_key_field_ids.
--   2) Adds `resource_id` to `integration_field_mappings` and
--      `integration_sync_records`, backfills them from the seed row,
--      then SET NOT NULL.
--   3) Drops the now-redundant per-integration globals
--      (assetLayoutId / matchKeyFieldIds) plus the old field-mapping
--      `integration_id` column and uniques. Replaces them with
--      `(resource_id, source_field)` and
--      `(integration_company_mapping_id, resource_id, external_id)`.
--
-- Backwards compatibility: post-migration every existing integration
-- has exactly one resource row and behaves identically — no operator
-- action required. Adding a second resource (UniFi clients) is a
-- net-new POST /resources call.

-- =====================================================================
-- 1. Create the integration_resources table.
-- =====================================================================

CREATE TABLE "integration_resources" (
    "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
    "integration_id"       UUID         NOT NULL,
    "resource_key"         TEXT         NOT NULL,
    "enabled"              BOOLEAN      NOT NULL DEFAULT true,
    "asset_layout_id"      UUID,
    "match_key_field_ids"  UUID[]       NOT NULL DEFAULT ARRAY[]::UUID[],
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_resources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_resources_integration_resource_key"
    ON "integration_resources" ("integration_id", "resource_key");

CREATE INDEX "integration_resources_layout_idx"
    ON "integration_resources" ("asset_layout_id");

ALTER TABLE "integration_resources"
    ADD CONSTRAINT "integration_resources_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_resources"
    ADD CONSTRAINT "integration_resources_asset_layout_id_fkey"
    FOREIGN KEY ("asset_layout_id") REFERENCES "asset_layouts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- 2. Seed one resource row per existing integration, carrying its
--    current globals. UniFi uses 'devices' (the existing-only resource);
--    every other driver uses 'records' (the placeholder key for
--    single-resource drivers).
-- =====================================================================

INSERT INTO "integration_resources" (
    "id",
    "integration_id",
    "resource_key",
    "enabled",
    "asset_layout_id",
    "match_key_field_ids",
    "created_at",
    "updated_at"
)
SELECT
    gen_random_uuid(),
    "id",
    CASE WHEN "driver" = 'unifi' THEN 'devices' ELSE 'records' END,
    true,
    "asset_layout_id",
    "match_key_field_ids",
    "created_at",
    CURRENT_TIMESTAMP
FROM "integrations";

-- =====================================================================
-- 3. Add resource_id to integration_field_mappings and backfill.
-- =====================================================================

ALTER TABLE "integration_field_mappings"
    ADD COLUMN "resource_id" UUID;

UPDATE "integration_field_mappings" fm
SET "resource_id" = ir."id"
FROM "integration_resources" ir
WHERE ir."integration_id" = fm."integration_id";

ALTER TABLE "integration_field_mappings"
    ALTER COLUMN "resource_id" SET NOT NULL;

DROP INDEX IF EXISTS "integration_field_mappings_integration_source_key";

ALTER TABLE "integration_field_mappings"
    DROP CONSTRAINT IF EXISTS "integration_field_mappings_integration_id_fkey";

ALTER TABLE "integration_field_mappings"
    DROP COLUMN "integration_id";

ALTER TABLE "integration_field_mappings"
    ADD CONSTRAINT "integration_field_mappings_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "integration_resources"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "integration_field_mappings_resource_source_key"
    ON "integration_field_mappings" ("resource_id", "source_field");

-- =====================================================================
-- 4. Add resource_id to integration_sync_records and backfill.
--    Every existing sync record points at the integration's seed
--    resource row (joined through the company mapping → integration).
-- =====================================================================

ALTER TABLE "integration_sync_records"
    ADD COLUMN "resource_id" UUID;

UPDATE "integration_sync_records" sr
SET "resource_id" = ir."id"
FROM "integration_company_mappings" cm
JOIN "integration_resources" ir
    ON ir."integration_id" = cm."integration_id"
WHERE cm."id" = sr."integration_company_mapping_id";

ALTER TABLE "integration_sync_records"
    ALTER COLUMN "resource_id" SET NOT NULL;

DROP INDEX IF EXISTS "integration_sync_records_mapping_external_key";

ALTER TABLE "integration_sync_records"
    ADD CONSTRAINT "integration_sync_records_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "integration_resources"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "integration_sync_records_mapping_resource_external_key"
    ON "integration_sync_records" (
        "integration_company_mapping_id",
        "resource_id",
        "external_id"
    );

CREATE INDEX "integration_sync_records_resource_idx"
    ON "integration_sync_records" ("resource_id");

-- =====================================================================
-- 5. Drop the per-integration globals — they now live on the resource
--    container.
-- =====================================================================

ALTER TABLE "integrations"
    DROP CONSTRAINT IF EXISTS "integrations_asset_layout_id_fkey";

DROP INDEX IF EXISTS "integrations_asset_layout_id_idx";

ALTER TABLE "integrations"
    DROP COLUMN "asset_layout_id";

ALTER TABLE "integrations"
    DROP COLUMN "match_key_field_ids";
