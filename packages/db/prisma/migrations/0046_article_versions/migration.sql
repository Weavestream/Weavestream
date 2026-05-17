-- Article history: published versions (one row per explicit Save) plus
-- an at-most-one coalescing draft row per article for autosave sessions.
--
-- Tenant scoping: `company_id` is denormalised so the Prisma tenant
-- middleware can filter without joining (see TENANT_SCOPED_MODELS).
-- Hard-delete cascade: `purge()` deletes the article row, which deletes
-- every history row alongside it (`ON DELETE CASCADE`). No orphans.
--
-- Backfill: every existing article gets one published row at v=1 so the
-- history list is never empty on day one.

CREATE TABLE "article_versions" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "article_id"          UUID         NOT NULL,
    "company_id"          UUID         NOT NULL,
    "version"             INTEGER      NOT NULL,
    "is_draft"            BOOLEAN      NOT NULL DEFAULT FALSE,
    "title"               TEXT         NOT NULL,
    "slug"                TEXT         NOT NULL,
    "folder_id"           UUID,
    "visible_to_clients"  BOOLEAN      NOT NULL,
    "editor_mode"         TEXT         NOT NULL,
    "content"             JSONB,
    "markdown_source"     TEXT,
    "content_plaintext"   TEXT         NOT NULL,
    "excerpt"             TEXT,
    "changed_fields"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "changed_by"          UUID         NOT NULL,
    "change_reason"       TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_versions_article_version_uniq"
  ON "article_versions" ("article_id", "version");

CREATE INDEX "article_versions_article_draft_created_idx"
  ON "article_versions" ("article_id", "is_draft", "created_at");

CREATE INDEX "article_versions_company_created_idx"
  ON "article_versions" ("company_id", "created_at");

-- At most one active draft per article. Coalescing the autosave path
-- depends on this constraint: the service looks up "the draft" rather
-- than walking a list, and a concurrent insert race must fail with a
-- unique-violation rather than silently produce two drafts.
CREATE UNIQUE INDEX "article_versions_one_draft_per_article_uniq"
  ON "article_versions" ("article_id")
  WHERE "is_draft" = TRUE;

ALTER TABLE "article_versions"
  ADD CONSTRAINT "article_versions_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill v=1 for every existing article. `created_by` is nullable on
-- `articles` but `changed_by` is NOT NULL here, so we fall back to
-- `updated_by` (also nullable). If both are null (legacy seed rows), use
-- a sentinel zero-UUID so the constraint still holds; in practice every
-- article in the system was written by a real user.
INSERT INTO "article_versions" (
    "article_id",
    "company_id",
    "version",
    "is_draft",
    "title",
    "slug",
    "folder_id",
    "visible_to_clients",
    "editor_mode",
    "content",
    "markdown_source",
    "content_plaintext",
    "excerpt",
    "changed_fields",
    "changed_by",
    "change_reason",
    "created_at",
    "updated_at"
)
SELECT
    "id",
    "company_id",
    1,
    FALSE,
    "title",
    "slug",
    "folder_id",
    "visible_to_clients",
    "editor_mode",
    "content",
    "markdown_source",
    "content_plaintext",
    "excerpt",
    ARRAY['title','slug','folderId','visibleToClients','editorMode','content','markdownSource']::TEXT[],
    COALESCE("updated_by", "created_by", '00000000-0000-0000-0000-000000000000'::uuid),
    'initial version',
    "created_at",
    "updated_at"
FROM "articles";
