-- Phase 11: Universal integration framework.
--
-- Adds a global integration registry plus tenant-scoped fan-out tables.
-- One global `Integration` row drives many `IntegrationCompanyMapping`
-- rows (one per Weavestream company / external organisation pair). The
-- worker uses `IntegrationSyncRecord` for durable external↔asset linking
-- and `IntegrationFieldMapping` to project remote fields onto AssetField
-- targets. Run history lives in `IntegrationSyncRun` (global) +
-- `IntegrationSyncRunCompanyResult` (per-tenant).
--
-- Tenant scoping (apps/api/src/prisma/tenant-scoped-models.ts):
--   IntegrationCompanyMapping
--   IntegrationFieldMapping             (scoped via parent mapping FK)
--   IntegrationSyncRunCompanyResult
--   IntegrationSyncRecord
-- Global tables (SUPER_ADMIN-only via @RequirePermission):
--   Integration, IntegrationSecret, IntegrationSyncRun
--
-- Secrets are AES-256-GCM ciphertext (INTEGRATION_SECRET_KEY) — never
-- stored in plaintext, never returned by any read endpoint. Deleting an
-- Integration cascades the framework rows but never touches Asset rows
-- (deletion safety is handled in the API service layer, which clears
-- `assets.external_id` / `assets.external_source` for affected assets
-- inside the same transaction).

-- =====================================================================
-- Enums
-- =====================================================================

CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');
CREATE TYPE "IntegrationSyncDirection" AS ENUM ('source_wins', 'preserve_manual', 'manual_only');
CREATE TYPE "IntegrationRunKind" AS ENUM ('manual', 'scheduled');
CREATE TYPE "IntegrationRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- =====================================================================
-- integrations  (GLOBAL — SUPER_ADMIN-managed, no company_id)
-- =====================================================================

CREATE TABLE "integrations" (
    "id"              UUID                NOT NULL DEFAULT gen_random_uuid(),
    "driver"          TEXT                NOT NULL,
    "name"            TEXT                NOT NULL,
    "status"          "IntegrationStatus" NOT NULL DEFAULT 'PAUSED',
    "config"          JSONB               NOT NULL DEFAULT '{}'::jsonb,
    "sync_cron"       TEXT,
    "last_run_at"     TIMESTAMP(3),
    "last_run_status" TEXT,
    "created_by"      UUID,
    "created_at"      TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3)        NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integrations_driver_name_key"
    ON "integrations" ("driver", "name");

CREATE INDEX "integrations_driver_idx"
    ON "integrations" ("driver");

-- =====================================================================
-- integration_secrets  (1:1 with integrations, AES-256-GCM ciphertext)
-- =====================================================================

CREATE TABLE "integration_secrets" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "integration_id" UUID         NOT NULL,
    "ciphertext"     TEXT         NOT NULL,
    "updated_at"     TIMESTAMP(3) NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_secrets_integration_id_key"
    ON "integration_secrets" ("integration_id");

ALTER TABLE "integration_secrets"
    ADD CONSTRAINT "integration_secrets_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- integration_company_mappings  (TENANT-SCOPED via company_id)
-- =====================================================================

CREATE TABLE "integration_company_mappings" (
    "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
    "integration_id"       UUID         NOT NULL,
    "company_id"           UUID         NOT NULL,
    "asset_layout_id"      UUID         NOT NULL,
    "external_org_id"      TEXT         NOT NULL,
    "external_org_name"    TEXT,
    "enabled"              BOOLEAN      NOT NULL DEFAULT true,
    "filter"               JSONB        NOT NULL DEFAULT '{}'::jsonb,
    "match_key_field_ids"  UUID[]       NOT NULL DEFAULT ARRAY[]::UUID[],
    "created_by"           UUID,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_company_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_company_mappings_integration_external_org_key"
    ON "integration_company_mappings" ("integration_id", "external_org_id");

CREATE INDEX "integration_company_mappings_company_integration_idx"
    ON "integration_company_mappings" ("company_id", "integration_id");

CREATE INDEX "integration_company_mappings_layout_idx"
    ON "integration_company_mappings" ("asset_layout_id");

ALTER TABLE "integration_company_mappings"
    ADD CONSTRAINT "integration_company_mappings_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_company_mappings"
    ADD CONSTRAINT "integration_company_mappings_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_company_mappings"
    ADD CONSTRAINT "integration_company_mappings_asset_layout_id_fkey"
    FOREIGN KEY ("asset_layout_id") REFERENCES "asset_layouts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- integration_field_mappings  (one per (mapping, source_field))
-- =====================================================================

CREATE TABLE "integration_field_mappings" (
    "id"                              UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "integration_company_mapping_id"  UUID                       NOT NULL,
    "source_field"                    TEXT                       NOT NULL,
    "target_field_id"                 UUID                       NOT NULL,
    "sync_direction"                  "IntegrationSyncDirection" NOT NULL DEFAULT 'source_wins',
    "transform"                       JSONB,
    "created_at"                      TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                      TIMESTAMP(3)               NOT NULL,

    CONSTRAINT "integration_field_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_field_mappings_mapping_source_key"
    ON "integration_field_mappings" ("integration_company_mapping_id", "source_field");

CREATE INDEX "integration_field_mappings_target_field_idx"
    ON "integration_field_mappings" ("target_field_id");

ALTER TABLE "integration_field_mappings"
    ADD CONSTRAINT "integration_field_mappings_mapping_id_fkey"
    FOREIGN KEY ("integration_company_mapping_id") REFERENCES "integration_company_mappings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_field_mappings"
    ADD CONSTRAINT "integration_field_mappings_target_field_id_fkey"
    FOREIGN KEY ("target_field_id") REFERENCES "asset_fields"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- integration_sync_runs  (GLOBAL — one per orchestrator job)
-- =====================================================================

CREATE TABLE "integration_sync_runs" (
    "id"             UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "integration_id" UUID                   NOT NULL,
    "kind"           "IntegrationRunKind"   NOT NULL,
    "status"         "IntegrationRunStatus" NOT NULL DEFAULT 'queued',
    "dry_run"        BOOLEAN                NOT NULL DEFAULT false,
    "triggered_by"   UUID,
    "started_at"     TIMESTAMP(3),
    "finished_at"    TIMESTAMP(3),
    "totals"         JSONB,
    "error"          TEXT,
    "created_at"     TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "integration_sync_runs_integration_recent_idx"
    ON "integration_sync_runs" ("integration_id", "created_at" DESC);

ALTER TABLE "integration_sync_runs"
    ADD CONSTRAINT "integration_sync_runs_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- integration_sync_run_company_results  (TENANT-SCOPED via company_id)
-- =====================================================================

CREATE TABLE "integration_sync_run_company_results" (
    "id"                              UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "sync_run_id"                     UUID                   NOT NULL,
    "integration_company_mapping_id"  UUID                   NOT NULL,
    "company_id"                      UUID                   NOT NULL,
    "status"                          "IntegrationRunStatus" NOT NULL DEFAULT 'queued',
    "started_at"                      TIMESTAMP(3),
    "finished_at"                     TIMESTAMP(3),
    "totals"                          JSONB,
    "conflicts"                       JSONB,
    "error"                           TEXT,
    "created_at"                      TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_sync_run_company_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_sync_run_company_results_run_mapping_key"
    ON "integration_sync_run_company_results" ("sync_run_id", "integration_company_mapping_id");

CREATE INDEX "integration_sync_run_company_results_company_recent_idx"
    ON "integration_sync_run_company_results" ("company_id", "created_at" DESC);

ALTER TABLE "integration_sync_run_company_results"
    ADD CONSTRAINT "integration_sync_run_company_results_run_id_fkey"
    FOREIGN KEY ("sync_run_id") REFERENCES "integration_sync_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_sync_run_company_results"
    ADD CONSTRAINT "integration_sync_run_company_results_mapping_id_fkey"
    FOREIGN KEY ("integration_company_mapping_id") REFERENCES "integration_company_mappings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- integration_sync_records  (TENANT-SCOPED via company_id)
-- =====================================================================
--
-- One row per (mapping, externalId) — the durable link between a
-- driver-side record and a Weavestream Asset. `last_synced_field_checksums`
-- is a JSON map keyed by AssetField.id; the worker uses it to detect
-- manual edits when sync_direction = preserve_manual.
--
-- The unique index on (asset_id) enforces a single ownership invariant:
-- an Asset can be claimed by at most one IntegrationCompanyMapping at a
-- time. Releasing (clearing external_id / external_source on the Asset)
-- is a separate API operation that deletes this row first.

CREATE TABLE "integration_sync_records" (
    "id"                              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "integration_company_mapping_id"  UUID         NOT NULL,
    "sync_run_id"                     UUID,
    "company_id"                      UUID         NOT NULL,
    "asset_id"                        UUID         NOT NULL,
    "external_id"                     TEXT         NOT NULL,
    "last_synced_at"                  TIMESTAMP(3) NOT NULL,
    "checksum"                        TEXT         NOT NULL,
    "last_synced_field_checksums"     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    "created_at"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_sync_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_sync_records_mapping_external_key"
    ON "integration_sync_records" ("integration_company_mapping_id", "external_id");

CREATE UNIQUE INDEX "integration_sync_records_asset_id_key"
    ON "integration_sync_records" ("asset_id");

CREATE INDEX "integration_sync_records_company_mapping_idx"
    ON "integration_sync_records" ("company_id", "integration_company_mapping_id");

ALTER TABLE "integration_sync_records"
    ADD CONSTRAINT "integration_sync_records_mapping_id_fkey"
    FOREIGN KEY ("integration_company_mapping_id") REFERENCES "integration_company_mappings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_sync_records"
    ADD CONSTRAINT "integration_sync_records_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_sync_records"
    ADD CONSTRAINT "integration_sync_records_run_id_fkey"
    FOREIGN KEY ("sync_run_id") REFERENCES "integration_sync_runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- assets — supplemental (company_id, external_source, external_id) index
-- =====================================================================
--
-- Speeds up the match-by-key resolver's "is this externalId already
-- claimed?" lookup. Partial because most assets are operator-created
-- and carry NULLs in both columns.

CREATE INDEX "assets_company_external_source_external_id_idx"
    ON "assets" ("company_id", "external_source", "external_id")
    WHERE "external_id" IS NOT NULL;
