-- Workspace-wide default editor mode for newly-created articles. The
-- web "New article" form seeds its toolbar from this value so an
-- operator can choose Markdown as the org-wide default rather than
-- always landing in the WYSIWYG (Tiptap) editor. Existing articles
-- keep their own `editor_mode`; this only affects the create flow.
--
-- Constrained to the same set the article body discriminator accepts
-- (`tiptap` | `markdown`) so a malformed string in the singleton row
-- can never poison the form. CHECK constraint mirrors what
-- `articleEditorModeSchema` allows in @weavestream/shared.

ALTER TABLE "system_settings"
ADD COLUMN "article_default_editor_mode" TEXT NOT NULL DEFAULT 'tiptap';

ALTER TABLE "system_settings"
ADD CONSTRAINT "system_settings_article_default_editor_mode_check"
CHECK ("article_default_editor_mode" IN ('tiptap', 'markdown'));
