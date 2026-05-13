-- Phase 8 — Domain Check v2.
--
-- Adds three columns:
--   * monitored_domains.latest_score              denormalised 0-100 percent
--   * monitored_domains.dkim_selector_override    optional override list
--   * domain_checks.score                         percent score per check
--   * domain_checks.schema_version                rubric version per check
--
-- Older rows (written before this migration) keep score = NULL and
-- schema_version = 1. The v2 rubric only fills in scores for rows
-- written after `runDomainCheck` starts emitting `details.score`. The
-- UI surfaces "Ungraded" for any row with score IS NULL so the change
-- is fully backward compatible.
--
-- No data-class expansion at rest — the new fields are integers and a
-- short text override; the structured payload (SPF/DMARC/DKIM/HSTS)
-- lives inside the existing `details` jsonb column and so requires no
-- new DDL.

ALTER TABLE "monitored_domains"
    ADD COLUMN "latest_score"             INTEGER,
    ADD COLUMN "dkim_selector_override"   TEXT;

ALTER TABLE "domain_checks"
    ADD COLUMN "score"           INTEGER,
    ADD COLUMN "schema_version"  INTEGER NOT NULL DEFAULT 1;

-- Sentinel range check: percent must be 0-100 when present. Defensive
-- belt; the application schema validates this too but the constraint
-- keeps direct-DB writes (CLI, restore) honest.
ALTER TABLE "monitored_domains"
    ADD CONSTRAINT "monitored_domains_latest_score_range_chk"
    CHECK (latest_score IS NULL OR (latest_score >= 0 AND latest_score <= 100));

ALTER TABLE "domain_checks"
    ADD CONSTRAINT "domain_checks_score_range_chk"
    CHECK (score IS NULL OR (score >= 0 AND score <= 100));

-- Index the denormalised score so the admin alerts panel can pull the
-- "< 35%" / "< 55%" buckets without a sequential scan once data
-- volume grows. Partial index keeps the rowcount small for active
-- domains only.
CREATE INDEX "monitored_domains_company_score_idx"
    ON "monitored_domains" ("company_id", "latest_score")
    WHERE "archived_at" IS NULL;
