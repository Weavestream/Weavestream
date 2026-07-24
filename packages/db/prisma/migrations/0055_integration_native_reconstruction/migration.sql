-- Generalize integration resources from asset-only projections into typed,
-- native reconstruction targets while preserving every existing binding as
-- an active asset binding.

-- The previous schema did not bound transform size. Fail before making any
-- schema changes if legacy rows cannot satisfy the new constraint, and give
-- operators enough information to remediate those rows before retrying.
--
-- Full preflight query:
--   SELECT "id", octet_length("transform"::TEXT) AS "transform_bytes"
--   FROM "integration_field_mappings"
--   WHERE "transform" IS NOT NULL
--     AND octet_length("transform"::TEXT) > 65536
--   ORDER BY "transform_bytes" DESC, "id";
--
-- Remediation: reduce each reported transform to at most 65536 bytes, or set
-- it to NULL only when an identity transform is correct for that mapping.
DO $$
DECLARE
    oversized_mapping_count BIGINT;
    oversized_mapping_ids TEXT;
BEGIN
    SELECT COUNT(*)
    INTO oversized_mapping_count
    FROM "integration_field_mappings"
    WHERE "transform" IS NOT NULL
      AND octet_length("transform"::TEXT) > 65536;

    IF oversized_mapping_count > 0 THEN
        SELECT string_agg(oversized."id"::TEXT, ', ' ORDER BY oversized."id"::TEXT)
        INTO oversized_mapping_ids
        FROM (
            SELECT "id"
            FROM "integration_field_mappings"
            WHERE "transform" IS NOT NULL
              AND octet_length("transform"::TEXT) > 65536
            ORDER BY "id"
            LIMIT 20
        ) AS oversized;

        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'Migration 0055 cannot enforce the 65536-byte transform limit: %s legacy integration_field_mappings row(s) are oversized',
                oversized_mapping_count
            ),
            DETAIL = format(
                'Affected mapping IDs (up to 20): %s',
                oversized_mapping_ids
            ),
            HINT = 'Run the preflight SELECT documented at the top of this migration, then reduce each transform to at most 65536 bytes or set it to NULL only if identity behavior is intended.';
    END IF;
END
$$;

CREATE TYPE "IntegrationTargetKind" AS ENUM (
    'asset', 'subnet', 'ip_reservation', 'article', 'relation'
);

CREATE TYPE "IntegrationSyncState" AS ENUM ('active', 'stale', 'blocked');

CREATE TYPE "ReconstructionGapKind" AS ENUM (
    'secret_blocked',
    'missing_dependency',
    'validation',
    'unsupported',
    'ambiguous',
    'synchronization_error'
);

-- Resource destination metadata is descriptor-owned. Defaults retain the
-- behavior of every pre-migration driver descriptor.
ALTER TABLE "integration_resources"
    ADD COLUMN "target_kind" "IntegrationTargetKind" NOT NULL DEFAULT 'asset',
    ADD COLUMN "target_config" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "depends_on_resource_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE UNIQUE INDEX "integration_resources_id_target_kind_key"
    ON "integration_resources" ("id", "target_kind");

ALTER TABLE "integration_resources"
    ADD CONSTRAINT "integration_resources_asset_configuration_check"
    CHECK (
        "target_kind" = 'asset'
        OR ("asset_layout_id" IS NULL AND cardinality("match_key_field_ids") = 0)
    ),
    ADD CONSTRAINT "integration_resources_target_config_size_check"
    CHECK (octet_length("target_config"::TEXT) <= 32768);

-- Field mappings have one destination. target_kind is denormalized and tied
-- back to the resource through a composite FK so a CHECK constraint can
-- enforce asset-field vs native-path mappings without an unsafe subquery.
ALTER TABLE "integration_field_mappings"
    ADD COLUMN "target_kind" "IntegrationTargetKind" NOT NULL DEFAULT 'asset',
    ADD COLUMN "target_path" VARCHAR(4096),
    ALTER COLUMN "target_field_id" DROP NOT NULL;

ALTER TABLE "integration_field_mappings"
    DROP CONSTRAINT "integration_field_mappings_resource_id_fkey";

ALTER TABLE "integration_field_mappings"
    ADD CONSTRAINT "integration_field_mappings_resource_target_fkey"
    FOREIGN KEY ("resource_id", "target_kind")
    REFERENCES "integration_resources" ("id", "target_kind")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_field_mappings_target_destination_check"
    CHECK (
        (
            "target_kind" = 'asset'
            AND "target_field_id" IS NOT NULL
            AND "target_path" IS NULL
        )
        OR (
            "target_kind" <> 'asset'
            AND "target_field_id" IS NULL
            AND "target_path" IS NOT NULL
        )
    ),
    ADD CONSTRAINT "integration_field_mappings_transform_size_check"
    CHECK ("transform" IS NULL OR octet_length("transform"::TEXT) <= 65536);

CREATE INDEX "integration_field_mappings_resource_target_idx"
    ON "integration_field_mappings" ("resource_id", "target_kind");

-- Existing sync records are backfilled as active asset records. New target
-- columns remain nullable individually; the target CHECK below requires one
-- and only one of them to be present and to agree with target_kind.
ALTER TABLE "integration_sync_records"
    ADD COLUMN "target_kind" "IntegrationTargetKind" NOT NULL DEFAULT 'asset',
    ADD COLUMN "subnet_id" UUID,
    ADD COLUMN "ip_reservation_id" UUID,
    ADD COLUMN "article_id" UUID,
    ADD COLUMN "relation_id" UUID,
    ADD COLUMN "state" "IntegrationSyncState" NOT NULL DEFAULT 'active',
    ADD COLUMN "last_seen_at" TIMESTAMP(3),
    ADD COLUMN "stale_since" TIMESTAMP(3),
    ADD COLUMN "source_updated_at" TIMESTAMP(3),
    ADD COLUMN "provenance" JSONB NOT NULL DEFAULT '{}';

UPDATE "integration_sync_records"
SET "target_kind" = 'asset',
    "state" = 'active',
    "last_seen_at" = "last_synced_at"
WHERE "last_seen_at" IS NULL;

ALTER TABLE "integration_sync_records"
    ALTER COLUMN "last_seen_at" SET NOT NULL,
    ALTER COLUMN "asset_id" DROP NOT NULL,
    DROP CONSTRAINT "integration_sync_records_resource_id_fkey";

ALTER TABLE "integration_sync_records"
    ADD CONSTRAINT "integration_sync_records_resource_target_fkey"
    FOREIGN KEY ("resource_id", "target_kind")
    REFERENCES "integration_resources" ("id", "target_kind")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_sync_records_subnet_id_fkey"
    FOREIGN KEY ("subnet_id") REFERENCES "subnets" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_sync_records_ip_reservation_id_fkey"
    FOREIGN KEY ("ip_reservation_id") REFERENCES "ip_reservations" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_sync_records_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "articles" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_sync_records_relation_id_fkey"
    FOREIGN KEY ("relation_id") REFERENCES "relations" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_sync_records_target_check"
    CHECK (
        num_nonnulls(
            "asset_id", "subnet_id", "ip_reservation_id", "article_id", "relation_id"
        ) = 1
        AND (
            ("target_kind" = 'asset' AND "asset_id" IS NOT NULL)
            OR ("target_kind" = 'subnet' AND "subnet_id" IS NOT NULL)
            OR ("target_kind" = 'ip_reservation' AND "ip_reservation_id" IS NOT NULL)
            OR ("target_kind" = 'article' AND "article_id" IS NOT NULL)
            OR ("target_kind" = 'relation' AND "relation_id" IS NOT NULL)
        )
    ),
    ADD CONSTRAINT "integration_sync_records_state_check"
    CHECK (
        ("state" = 'stale' AND "stale_since" IS NOT NULL)
        OR ("state" <> 'stale' AND "stale_since" IS NULL)
    ),
    ADD CONSTRAINT "integration_sync_records_provenance_check"
    CHECK (
        jsonb_typeof("provenance") = 'object'
        AND octet_length("provenance"::TEXT) <= 8192
    );

CREATE INDEX "integration_sync_records_resource_target_idx"
    ON "integration_sync_records" ("resource_id", "target_kind");
CREATE INDEX "integration_sync_records_subnet_id_idx"
    ON "integration_sync_records" ("subnet_id");
CREATE INDEX "integration_sync_records_ip_reservation_id_idx"
    ON "integration_sync_records" ("ip_reservation_id");
CREATE INDEX "integration_sync_records_article_id_idx"
    ON "integration_sync_records" ("article_id");
CREATE INDEX "integration_sync_records_relation_id_idx"
    ON "integration_sync_records" ("relation_id");
CREATE INDEX "integration_sync_records_active_evaluation_idx"
    ON "integration_sync_records" ("company_id", "resource_id", "state", "last_seen_at");

CREATE TABLE "integration_sync_checkpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "integration_company_mapping_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "cursor" VARCHAR(4096),
    "snapshot_at" TIMESTAMP(3),
    "high_water_at" TIMESTAMP(3),
    "last_completed_at" TIMESTAMP(3),
    "last_full_completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "integration_sync_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_sync_checkpoints_mapping_resource_key"
    ON "integration_sync_checkpoints" ("integration_company_mapping_id", "resource_id");
CREATE INDEX "integration_sync_checkpoints_company_mapping_idx"
    ON "integration_sync_checkpoints" ("company_id", "integration_company_mapping_id");
CREATE INDEX "integration_sync_checkpoints_resource_completed_idx"
    ON "integration_sync_checkpoints" ("resource_id", "last_completed_at");

ALTER TABLE "integration_sync_checkpoints"
    ADD CONSTRAINT "integration_sync_checkpoints_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_sync_checkpoints_mapping_id_fkey"
    FOREIGN KEY ("integration_company_mapping_id")
    REFERENCES "integration_company_mappings" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_sync_checkpoints_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "integration_resources" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "integration_reconstruction_summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "integration_company_mapping_id" UUID NOT NULL,
    "resource_id" UUID,
    "summary_key" VARCHAR(128) NOT NULL DEFAULT 'all',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "evaluated_at" TIMESTAMP(3) NOT NULL,
    "last_successful_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "integration_reconstruction_summaries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "integration_reconstruction_summaries_key_check" CHECK (
        ("resource_id" IS NULL AND "summary_key" = 'all')
        OR ("resource_id" IS NOT NULL AND "summary_key" = "resource_id"::TEXT)
    ),
    CONSTRAINT "integration_reconstruction_summaries_counts_check" CHECK (
        jsonb_typeof("counts") = 'object'
        AND octet_length("counts"::TEXT) <= 16384
    )
);

CREATE UNIQUE INDEX "integration_reconstruction_summaries_mapping_key_key"
    ON "integration_reconstruction_summaries" ("integration_company_mapping_id", "summary_key");
CREATE INDEX "integration_reconstruction_summaries_company_evaluated_idx"
    ON "integration_reconstruction_summaries" ("company_id", "evaluated_at");
CREATE INDEX "integration_reconstruction_summaries_resource_evaluated_idx"
    ON "integration_reconstruction_summaries" ("resource_id", "evaluated_at");

ALTER TABLE "integration_reconstruction_summaries"
    ADD CONSTRAINT "integration_reconstruction_summaries_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_reconstruction_summaries_mapping_id_fkey"
    FOREIGN KEY ("integration_company_mapping_id")
    REFERENCES "integration_company_mappings" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_reconstruction_summaries_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "integration_resources" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "integration_reconstruction_gaps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "integration_company_mapping_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "sync_record_id" UUID,
    "dedupe_key" VARCHAR(256) NOT NULL,
    "kind" "ReconstructionGapKind" NOT NULL,
    "message" VARCHAR(512) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "integration_reconstruction_gaps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "integration_reconstruction_gaps_details_check" CHECK (
        jsonb_typeof("details") = 'object'
        AND octet_length("details"::TEXT) <= 4096
    )
);

CREATE UNIQUE INDEX "integration_reconstruction_gaps_mapping_resource_dedupe_key"
    ON "integration_reconstruction_gaps" (
        "integration_company_mapping_id", "resource_id", "dedupe_key"
    );
CREATE INDEX "integration_reconstruction_gaps_company_active_idx"
    ON "integration_reconstruction_gaps" ("company_id", "last_seen_at")
    WHERE "resolved_at" IS NULL;
CREATE INDEX "integration_reconstruction_gaps_resource_active_kind_idx"
    ON "integration_reconstruction_gaps" ("resource_id", "kind", "last_seen_at")
    WHERE "resolved_at" IS NULL;
CREATE INDEX "integration_reconstruction_gaps_sync_record_idx"
    ON "integration_reconstruction_gaps" ("sync_record_id");

ALTER TABLE "integration_reconstruction_gaps"
    ADD CONSTRAINT "integration_reconstruction_gaps_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_reconstruction_gaps_mapping_id_fkey"
    FOREIGN KEY ("integration_company_mapping_id")
    REFERENCES "integration_company_mappings" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_reconstruction_gaps_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "integration_resources" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "integration_reconstruction_gaps_sync_record_id_fkey"
    FOREIGN KEY ("sync_record_id") REFERENCES "integration_sync_records" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
