-- Phase 6: per-user defaults for the Hudu-style command palette.
-- `search_defaults` shape (validated by userSearchDefaultsSchema):
--   { defaultComprehensive: boolean, defaultGlobal: boolean }
-- NULL means both toggles default to off, so no backfill is needed.

ALTER TABLE "users"
    ADD COLUMN "search_defaults" JSONB;
