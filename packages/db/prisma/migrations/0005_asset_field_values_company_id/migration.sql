-- Denormalize company_id onto asset_field_values so tenant-scope
-- middleware can gate bulk writes and (assetId, assetFieldId)-keyed
-- upserts, where a relational filter is not expressible in Prisma.
-- See apps/api/src/prisma/tenant-scoped-models.ts.

-- 1. Add the column nullable so we can backfill from the parent asset.
ALTER TABLE "asset_field_values"
  ADD COLUMN "company_id" UUID;

-- 2. Backfill from the existing parent Asset row.
UPDATE "asset_field_values" afv
SET "company_id" = a."company_id"
FROM "assets" a
WHERE afv."asset_id" = a."id"
  AND afv."company_id" IS NULL;

-- 3. Enforce non-null now that every row is populated.
ALTER TABLE "asset_field_values"
  ALTER COLUMN "company_id" SET NOT NULL;

-- 4. FK to the company so a tenant deletion cascades values (the
--    same cascade path you get today through assets, but keeps the
--    referential story honest if a value row ever outlives an asset
--    in the future).
ALTER TABLE "asset_field_values"
  ADD CONSTRAINT "asset_field_values_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Composite index to keep "show all values on this field in this
--    tenant" queries (used by unique-value checks and future
--    analytics) off a full scan.
CREATE INDEX "asset_field_values_company_field_idx"
  ON "asset_field_values" ("company_id", "asset_field_id");
