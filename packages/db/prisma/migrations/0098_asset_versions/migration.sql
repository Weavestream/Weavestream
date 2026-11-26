-- Asset version history (additive).
--
-- `asset_versions` is an append-only history of every real change to an
-- asset, same shape of idea as `password_versions`: each row is the full
-- state of the asset after one change. `field_values` is JSONB keyed by
-- asset_fields.id and holds values exactly as stored in
-- asset_field_values.value (plaintext JSON today - there is no encrypted
-- asset field type). `changed_by` is nullable: integration/system writes
-- and the lazily-written baseline row have no human author.
-- `company_id` is denormalised from the parent so the tenant middleware
-- can enforce scope without a relational filter. `redacted_*` mark rows an
-- operator scrubbed (values removed, row and number kept). No existing table is
-- altered and no data is backfilled here; baselines are written lazily on
-- an asset's first tracked edit.

CREATE TABLE "asset_versions" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "asset_id"        UUID         NOT NULL,
    "company_id"      UUID         NOT NULL,
    "version"         INTEGER      NOT NULL,
    "name"            TEXT         NOT NULL,
    "external_id"     TEXT,
    "external_source" TEXT,
    "field_values"    JSONB        NOT NULL DEFAULT '{}',
    "changed_fields"  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "changed_by"      UUID,
    "change_reason"   TEXT,
    "redacted_at"     TIMESTAMP(3),
    "redacted_fields" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_versions_asset_version_uniq"
  ON "asset_versions" ("asset_id", "version");

CREATE INDEX "asset_versions_asset_created_idx"
  ON "asset_versions" ("asset_id", "created_at");

ALTER TABLE "asset_versions"
  ADD CONSTRAINT "asset_versions_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_versions"
  ADD CONSTRAINT "asset_versions_changed_by_fkey"
  FOREIGN KEY ("changed_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
