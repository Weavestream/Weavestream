-- Phase 11 — promote field mappings, target layout, and match keys
-- from per-company to GLOBAL on the Integration.
--
-- Background:
--   The first pass of the integration framework attached three
--   configuration concerns to each `IntegrationCompanyMapping` row
--   (asset_layout_id, match_key_field_ids, and a per-mapping field-
--   mapping table). In practice every per-company mapping for the
--   same integration uses the *same* layout / target fields / match
--   keys — the layout itself is global (D-007). Forcing operators to
--   redefine these per company would cause configuration drift, make
--   the orgs UI cluttered, and silently break the moment two
--   mappings disagreed.
--
-- This migration:
--   1) DROPs `integration_field_mappings` so we can recreate it
--      keyed on `integration_id` (no production data exists yet —
--      Phase 11 is brand-new in 0020 and only Action1 dev tenants
--      have created rows so far).
--   2) MOVEs `asset_layout_id` and `match_key_field_ids` columns
--      from `integration_company_mappings` to `integrations`. The
--      column on the old table is dropped; the column on the new
--      table is nullable for layout (operator may not have picked
--      one yet) and defaults to an empty array for match keys.
--   3) RECREATEs `integration_field_mappings` with
--      `(integration_id, source_field)` as the natural key. The FK
--      on `target_field_id` still points at `asset_fields.id` —
--      AssetFields are GLOBAL so the link is unambiguous regardless
--      of which company is using the mapping.
--
-- Deletion semantics: cascade on `integrations` cleans up the new
-- field-mappings table. The Integration delete handler in the API
-- service still releases (not deletes) every Asset that was claimed
-- by any per-company mapping — see IntegrationsService.delete().

-- =====================================================================
-- 1. Drop the per-mapping field-mappings table.
-- =====================================================================

DROP TABLE "integration_field_mappings";

-- =====================================================================
-- 2. Move layout + match-keys from per-mapping to per-integration.
-- =====================================================================

ALTER TABLE "integration_company_mappings"
    DROP CONSTRAINT "integration_company_mappings_asset_layout_id_fkey";

DROP INDEX "integration_company_mappings_layout_idx";

ALTER TABLE "integration_company_mappings"
    DROP COLUMN "asset_layout_id";

ALTER TABLE "integration_company_mappings"
    DROP COLUMN "match_key_field_ids";

ALTER TABLE "integrations"
    ADD COLUMN "asset_layout_id"      UUID,
    ADD COLUMN "match_key_field_ids"  UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

ALTER TABLE "integrations"
    ADD CONSTRAINT "integrations_asset_layout_id_fkey"
    FOREIGN KEY ("asset_layout_id") REFERENCES "asset_layouts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "integrations_asset_layout_id_idx"
    ON "integrations" ("asset_layout_id");

-- =====================================================================
-- 3. Recreate the field-mappings table at the integration scope.
-- =====================================================================

CREATE TABLE "integration_field_mappings" (
    "id"               UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "integration_id"   UUID                       NOT NULL,
    "source_field"     TEXT                       NOT NULL,
    "target_field_id"  UUID                       NOT NULL,
    "sync_direction"   "IntegrationSyncDirection" NOT NULL DEFAULT 'source_wins',
    "transform"        JSONB,
    "created_at"       TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3)               NOT NULL,

    CONSTRAINT "integration_field_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_field_mappings_integration_source_key"
    ON "integration_field_mappings" ("integration_id", "source_field");

CREATE INDEX "integration_field_mappings_target_field_idx"
    ON "integration_field_mappings" ("target_field_id");

ALTER TABLE "integration_field_mappings"
    ADD CONSTRAINT "integration_field_mappings_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_field_mappings"
    ADD CONSTRAINT "integration_field_mappings_target_field_id_fkey"
    FOREIGN KEY ("target_field_id") REFERENCES "asset_fields"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
