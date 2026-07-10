-- Monotonic per-article revision counter used as an optimistic-
-- concurrency token by the AI chat apply path (WS-030).
--
-- The application increments it on every content-affecting write
-- (title/body/excerpt/editorMode), INCLUDING autosave drafts.
-- `ArticleVersion.version` cannot serve as this staleness token
-- because an explicit Save promotes the in-progress draft row in
-- place, REUSING its version number — so version does not change on
-- exactly the write a concurrent-edit guard must detect.
--
-- Apply-time guarding is done in the WHERE clause of the article
-- UPDATE (`revision = <base> AND archived_at IS NULL`), never as a
-- read-then-write check.
--
-- Backfill: DEFAULT 1 stamps every existing row. Monotonicity only
-- matters going forward, so no data-dependent backfill is needed.
ALTER TABLE "articles"
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
