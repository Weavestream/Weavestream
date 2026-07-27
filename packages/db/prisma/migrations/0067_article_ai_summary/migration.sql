-- Phase 4: article list summaries.
--
-- Four nullable columns on articles:
--
--   derived_excerpt   Machine-derived list excerpt. The legacy `excerpt`
--                     column is accepted from API callers and preserved
--                     on write, so stored values MAY be human-authored —
--                     provenance is unknowable retroactively, and read
--                     paths already ignore it (they re-derive from the
--                     body). This column is exclusively app-written, so
--                     recomputing it is always safe; it is what the
--                     projected list serves when no AI summary exists.
--   ai_summary        AI-generated summary; always matches the last
--                     published title+body (cleared in the same UPDATE
--                     that changes them).
--   ai_summary_model  Observability: which model produced the summary.
--   ai_summary_at     Generation state clock. NULL = pending (only ever
--                     created while the feature gate is on at write
--                     time); non-NULL = settled, with or without a
--                     summary. The worker's reconciliation sweep drains
--                     `ai_summary_at IS NULL`.
--
-- The seed below does two load-bearing things IN the migration rather
-- than post-deploy:
--
--   1. `ai_summary_at = NOW()` on every existing row marks the
--      pre-existing corpus settled. Generation is on-edit-only by
--      design: enabling the feature must never silently ship a
--      thousands-article backlog to the configured AI endpoint.
--   2. `derived_excerpt` is seeded from `content_plaintext` (whitespace
--      collapsed, word-boundary truncated at 280 chars, mirroring the
--      app's `excerptFromPlaintext`) so the projected list — which no
--      longer selects the body and cannot re-derive — never serves a
--      blank excerpt in the release window before the image-aware
--      refinement script (`apps/api/scripts/refine-article-derived-excerpts.ts`)
--      runs. Rows whose body LEADS with an image transiently show the
--      alt-text-ish plaintext head, exactly what stored excerpts held
--      pre-Phase-4; the refinement replaces the seed.
--
-- ai_settings gains `auto_summaries`, DEFAULT FALSE deliberately:
-- auto-summarization is a new data-class egress (article content to the
-- configured endpoint, proactively) and must be an explicit opt-in even
-- on installs that already enabled AI chat (CLAUDE.md §7).

ALTER TABLE "articles"
  ADD COLUMN "derived_excerpt" TEXT,
  ADD COLUMN "ai_summary" TEXT,
  ADD COLUMN "ai_summary_model" TEXT,
  ADD COLUMN "ai_summary_at" TIMESTAMP(3);

WITH src AS (
  SELECT id,
         NULLIF(btrim(regexp_replace("content_plaintext", '\s+', ' ', 'g')), '') AS plain
  FROM "articles"
),
cut AS (
  SELECT id,
         plain,
         left(plain, 280) AS c,
         CASE
           WHEN plain IS NULL THEN 0
           WHEN position(' ' IN reverse(left(plain, 280))) = 0 THEN 0
           ELSE 280 - position(' ' IN reverse(left(plain, 280))) + 1
         END AS last_space
  FROM src
)
UPDATE "articles" a
SET "derived_excerpt" = CASE
      WHEN cut.plain IS NULL THEN NULL
      WHEN length(cut.plain) <= 280 THEN cut.plain
      -- Mirror excerptFromPlaintext: back up to the last space only when
      -- it sits past 60% of the budget, then trim and add the ellipsis.
      WHEN cut.last_space - 1 > 168 THEN rtrim(left(cut.c, cut.last_space - 1)) || '…'
      ELSE rtrim(cut.c) || '…'
    END,
    "ai_summary_at" = NOW()
FROM cut
WHERE a.id = cut.id;

ALTER TABLE "ai_settings"
  ADD COLUMN "auto_summaries" BOOLEAN NOT NULL DEFAULT false;
