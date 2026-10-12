-- Driver-supplied integration sections (validated plain data) shown on the
-- asset page. Lives on the binding, so it is removed with it.
-- AlterTable
ALTER TABLE "integration_sync_records" ADD COLUMN "section_data" JSONB;
