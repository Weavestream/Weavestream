-- Integration field mapping: standard fields a person changed are not
-- overwritten; the sync records the difference on the binding instead, and
-- "Keep ours" choices suppress it until the source value changes.
-- AlterTable
ALTER TABLE "integration_sync_records" ADD COLUMN "field_diffs" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "integration_sync_records" ADD COLUMN "field_resolutions" JSONB NOT NULL DEFAULT '{}';
