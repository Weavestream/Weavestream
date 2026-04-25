-- Per-article editor mode: tiptap (JSON content) or markdown (source text).
-- Markdown rows leave content null; tiptap rows leave markdown_source null.

ALTER TABLE "articles" ADD COLUMN "editor_mode" TEXT NOT NULL DEFAULT 'tiptap';
ALTER TABLE "articles" ADD COLUMN "markdown_source" TEXT;
ALTER TABLE "articles" ALTER COLUMN "content" DROP NOT NULL;

ALTER TABLE "articles" ADD CONSTRAINT "articles_editor_mode_content_check" CHECK (
  (editor_mode = 'tiptap' AND "content" IS NOT NULL)
  OR
  (editor_mode = 'markdown' AND "markdown_source" IS NOT NULL)
);
