-- Workspace-wide toggle that controls whether the web article editor
-- emits debounced autosave PATCHes (`draft: true`). Default OFF so
-- existing tenants don't suddenly start writing in-progress edits to
-- the database; an operator must opt in from /admin/settings.

ALTER TABLE "system_settings"
ADD COLUMN "article_autosave_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
