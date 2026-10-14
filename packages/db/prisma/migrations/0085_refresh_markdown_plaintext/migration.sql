-- Markdown search text: queue a one-time refresh of every Markdown
-- article's derived plaintext and excerpt. The extractor
-- (`markdownToPlaintext`) now keeps underscores inside words and the
-- contents of code blocks, but rows saved before that still carry the
-- old text, so search misses them until each article is edited.
--
-- The extractor is TypeScript, so SQL cannot redo the work here. This
-- leaves a marker instead; MarkdownPlaintextRefreshService sees it on
-- boot and refreshes every Markdown article in the background (guarded
-- per row, so live edits always win). The api runs an early pass and
-- keeps the marker, because the previous worker can still save
-- articles with the old extractor until it is replaced; the new worker
-- starts after that, runs the final pass and drops the marker. A
-- failed run keeps the marker and resumes on the next boot. No Markdown articles (a new instance, the shadow database):
-- no marker, so the schema stays identical to schema.prisma.
--
-- A later change to the extractor re-queues the same refresh with the
-- same statement.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "articles" WHERE "editor_mode" = 'markdown') THEN
    CREATE TABLE IF NOT EXISTS "pending_markdown_plaintext_refresh" (
      "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  END IF;
END $$;
