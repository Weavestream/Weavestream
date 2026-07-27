-- Mixed-version rollout guard for `ai_summary_at` (follow-up to 0067).
--
-- 0067 backfilled the existing corpus settled but left the column with
-- no DEFAULT, so during a rolling deploy an application instance still
-- running pre-0067 code INSERTs articles with `ai_summary_at = NULL` —
-- indistinguishable from "generation pending". After a later opt-in,
-- the reconciliation sweep would summarize (and egress) that backlog
-- despite the on-edit-only policy, whose invariant is that NULL is
-- only ever created while the feature gate is ON at write time.
--
-- The DEFAULT closes exactly that gap: post-0067 code always writes
-- the column explicitly (create, update, and the integration writer
-- decide pending-vs-settled from the captured gate), so the default is
-- reachable only by writers that omit the column — that is, old
-- application instances. Their inserts now land settled; the article
-- self-heals into a summary on its next edit, and nothing egresses
-- without an edit made while the gate is on.
--
-- The conditional backfill settles any stray NULLs that predate this
-- migration ONLY when auto-summaries is not enabled anywhere: with the
-- gate on, NULL rows are legitimately pending work-in-flight and must
-- be left for the sweep.

ALTER TABLE "articles" ALTER COLUMN "ai_summary_at" SET DEFAULT now();

UPDATE "articles"
SET "ai_summary_at" = now()
WHERE "ai_summary_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "ai_settings" WHERE "auto_summaries");
