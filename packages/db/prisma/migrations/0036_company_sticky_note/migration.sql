-- Per-company sticky note banner. Two nullable columns on `companies`
-- + a small enum for severity. Additive-only; existing rows need no
-- backfill (both columns default to NULL → no banner renders).

CREATE TYPE "StickyNoteSeverity" AS ENUM (
  'INFO',
  'WARN',
  'CRITICAL'
);

ALTER TABLE "companies"
  ADD COLUMN "sticky_note_text"     TEXT,
  ADD COLUMN "sticky_note_severity" "StickyNoteSeverity";
