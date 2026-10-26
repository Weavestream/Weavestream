-- The record's kind in the source system (e.g. NinjaOne nodeClass), so the
-- "Open in" link can pick the source page for that kind. Filled by the next
-- sync; existing rows stay null until then.
ALTER TABLE "integration_sync_records"
    ADD COLUMN "source_kind" TEXT;

ALTER TABLE "integration_sync_records"
    ADD CONSTRAINT "integration_sync_records_source_kind_check"
    CHECK ("source_kind" ~ '^[A-Za-z0-9_.-]{1,64}$');
