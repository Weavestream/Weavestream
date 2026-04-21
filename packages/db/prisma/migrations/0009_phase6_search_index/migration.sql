-- Phase 6: global & scoped full-text search.
--
-- Single `search_index` table that every searchable entity funnels
-- into — Asset, Article, Upload today, extensible to more later. Two
-- GENERATED tsvector columns are maintained per row so the same table
-- can drive both operator and client searches with different
-- visibility:
--
--   body_public_tsv    = weight(title, A) || weight(body_public, B)
--   body_internal_tsv  = weight(title, A) || weight(body_internal, B)
--
-- body_public excludes content on fields / rows that are not visible
-- to clients; body_internal always carries the full text. Query
-- against body_public_tsv for CLIENT_USER callers and against
-- body_internal_tsv for everyone else.
--
-- Article + Upload rows are kept in sync with pure-SQL triggers
-- because their plaintext representation is already in a column
-- (`content_plaintext`, `filename`). Asset rows are maintained by the
-- API's SearchIndexService because per-field client visibility and
-- the FieldTypeStrategy.toPlaintext logic live in TypeScript.

CREATE TABLE "search_index" (
    "entity_type"        TEXT         NOT NULL,
    "entity_id"          UUID         NOT NULL,
    "company_id"         UUID         NOT NULL,
    "title"              TEXT         NOT NULL DEFAULT '',
    "body_public"        TEXT         NOT NULL DEFAULT '',
    "body_internal"      TEXT         NOT NULL DEFAULT '',
    "visible_to_clients" BOOLEAN      NOT NULL DEFAULT true,
    "layout_id"          UUID,
    "archived_at"        TIMESTAMP(3),
    "updated_at"         TIMESTAMP(3) NOT NULL,
    "body_public_tsv"    tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("body_public", '')), 'B')
    ) STORED,
    "body_internal_tsv"  tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("body_internal", '')), 'B')
    ) STORED,

    CONSTRAINT "search_index_pkey" PRIMARY KEY ("entity_type", "entity_id")
);

ALTER TABLE "search_index"
    ADD CONSTRAINT "search_index_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- GIN indexes that the actual `@@` match queries will hit.
CREATE INDEX "search_index_body_public_tsv_idx"
    ON "search_index" USING GIN ("body_public_tsv");

CREATE INDEX "search_index_body_internal_tsv_idx"
    ON "search_index" USING GIN ("body_internal_tsv");

-- Secondary indexes for recency-tie-break scans and maintenance sweeps.
CREATE INDEX "search_index_company_updated_at_idx"
    ON "search_index" ("company_id", "updated_at" DESC);

CREATE INDEX "search_index_company_entity_archived_idx"
    ON "search_index" ("company_id", "entity_type", "archived_at");

-- ---------------------------------------------------------------------
-- Article sync: articles carry row-level visibility via
-- `visible_to_clients`. When hidden, body_public stays empty so a
-- client query never matches the body; the query layer also filters
-- `visible_to_clients = true` defensively.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_index_upsert_article() RETURNS trigger AS $$
BEGIN
    INSERT INTO "search_index" (
        "entity_type", "entity_id", "company_id", "title",
        "body_public", "body_internal", "visible_to_clients",
        "layout_id", "archived_at", "updated_at"
    ) VALUES (
        'article', NEW."id", NEW."company_id", NEW."title",
        CASE WHEN NEW."visible_to_clients"
             THEN coalesce(NEW."content_plaintext", '')
             ELSE ''
        END,
        coalesce(NEW."content_plaintext", ''),
        NEW."visible_to_clients",
        NULL,
        NEW."archived_at",
        NEW."updated_at"
    )
    ON CONFLICT ("entity_type", "entity_id") DO UPDATE
    SET "company_id"         = EXCLUDED."company_id",
        "title"              = EXCLUDED."title",
        "body_public"        = EXCLUDED."body_public",
        "body_internal"      = EXCLUDED."body_internal",
        "visible_to_clients" = EXCLUDED."visible_to_clients",
        "archived_at"        = EXCLUDED."archived_at",
        "updated_at"         = EXCLUDED."updated_at";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION search_index_delete_article() RETURNS trigger AS $$
BEGIN
    DELETE FROM "search_index"
    WHERE "entity_type" = 'article' AND "entity_id" = OLD."id";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "articles_search_index_upsert"
    AFTER INSERT OR UPDATE ON "articles"
    FOR EACH ROW EXECUTE FUNCTION search_index_upsert_article();

CREATE TRIGGER "articles_search_index_delete"
    AFTER DELETE ON "articles"
    FOR EACH ROW EXECUTE FUNCTION search_index_delete_article();

-- ---------------------------------------------------------------------
-- Upload sync: only filename is indexed (both as title and body).
-- Soft-deleted rows (`deleted_at` NOT NULL) are removed from the index
-- so they never surface in palette hits.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_index_upsert_upload() RETURNS trigger AS $$
BEGIN
    IF NEW."deleted_at" IS NOT NULL THEN
        DELETE FROM "search_index"
        WHERE "entity_type" = 'upload' AND "entity_id" = NEW."id";
        RETURN NEW;
    END IF;

    INSERT INTO "search_index" (
        "entity_type", "entity_id", "company_id", "title",
        "body_public", "body_internal", "visible_to_clients",
        "layout_id", "archived_at", "updated_at"
    ) VALUES (
        'upload', NEW."id", NEW."company_id", NEW."filename",
        NEW."filename",
        NEW."filename",
        true,
        NULL,
        NULL,
        NEW."created_at"
    )
    ON CONFLICT ("entity_type", "entity_id") DO UPDATE
    SET "company_id"    = EXCLUDED."company_id",
        "title"         = EXCLUDED."title",
        "body_public"   = EXCLUDED."body_public",
        "body_internal" = EXCLUDED."body_internal",
        "updated_at"    = EXCLUDED."updated_at";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION search_index_delete_upload() RETURNS trigger AS $$
BEGIN
    DELETE FROM "search_index"
    WHERE "entity_type" = 'upload' AND "entity_id" = OLD."id";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "uploads_search_index_upsert"
    AFTER INSERT OR UPDATE ON "uploads"
    FOR EACH ROW EXECUTE FUNCTION search_index_upsert_upload();

CREATE TRIGGER "uploads_search_index_delete"
    AFTER DELETE ON "uploads"
    FOR EACH ROW EXECUTE FUNCTION search_index_delete_upload();

-- ---------------------------------------------------------------------
-- Backfill
--
-- Article + Upload rows are backfilled from their source tables here.
-- Asset rows are inserted with just `name` as both title and body;
-- the API's startup reindex (`spiffy-docs reindex-search`) replaces
-- those stubs with properly-split field-value bodies because the
-- per-field visibility + FieldTypeStrategy.toPlaintext logic cannot
-- run from pure SQL.
-- ---------------------------------------------------------------------

INSERT INTO "search_index" (
    "entity_type", "entity_id", "company_id", "title",
    "body_public", "body_internal", "visible_to_clients",
    "layout_id", "archived_at", "updated_at"
)
SELECT
    'article', "id", "company_id", "title",
    CASE WHEN "visible_to_clients"
         THEN coalesce("content_plaintext", '')
         ELSE ''
    END,
    coalesce("content_plaintext", ''),
    "visible_to_clients",
    NULL,
    "archived_at",
    "updated_at"
FROM "articles"
ON CONFLICT ("entity_type", "entity_id") DO NOTHING;

INSERT INTO "search_index" (
    "entity_type", "entity_id", "company_id", "title",
    "body_public", "body_internal", "visible_to_clients",
    "layout_id", "archived_at", "updated_at"
)
SELECT
    'upload', "id", "company_id", "filename",
    "filename", "filename",
    true, NULL, NULL,
    "created_at"
FROM "uploads"
WHERE "deleted_at" IS NULL
ON CONFLICT ("entity_type", "entity_id") DO NOTHING;

INSERT INTO "search_index" (
    "entity_type", "entity_id", "company_id", "title",
    "body_public", "body_internal", "visible_to_clients",
    "layout_id", "archived_at", "updated_at"
)
SELECT
    'asset', "id", "company_id", "name",
    "name", "name",
    true, "asset_layout_id",
    "archived_at",
    "updated_at"
FROM "assets"
ON CONFLICT ("entity_type", "entity_id") DO NOTHING;
