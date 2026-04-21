-- =====================================================================
-- Phase 8 follow-up: tokenise domain hostnames for search.
-- =====================================================================
--
-- Postgres' `english` text-search parser treats `raphaelhome.com` as a
-- single token (class "host"), so a non-comprehensive search for
-- "raphael" never matches the row. The 0011 trigger only wrote the raw
-- hostname into the body, which meant the only way to find a domain in
-- the sidebar search was to type its full label.
--
-- This migration replaces the upsert trigger function so the body
-- contains both the original hostname (weight B, keeps exact-match
-- semantics intact) and a dot-split variant ("raphaelhome com"), which
-- surfaces the domain's constituent labels as individual lexemes that
-- `websearch_to_tsquery('english', 'raphael')` can prefix-match against
-- after English stemming. The delete trigger is unchanged — we redefine
-- the function in place via CREATE OR REPLACE.
--
-- After swapping the function we touch every existing row so the
-- trigger fires and the search_index rows pick up the new body_public /
-- body_internal shape without a full `reindex-search` run.

CREATE OR REPLACE FUNCTION search_index_upsert_monitored_domain()
RETURNS trigger AS $$
DECLARE
    parts text := regexp_replace(NEW."hostname", '\.', ' ', 'g');
BEGIN
    INSERT INTO "search_index" (
        "entity_type", "entity_id", "company_id", "title",
        "body_public", "body_internal", "visible_to_clients",
        "layout_id", "archived_at", "updated_at"
    ) VALUES (
        'domain',
        NEW."id",
        NEW."company_id",
        NEW."hostname",
        CASE WHEN NEW."visible_to_clients"
             THEN NEW."hostname" || ' ' || parts
             ELSE ''
        END,
        NEW."hostname" || ' ' || parts || ' ' || NEW."latest_status"::text,
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

-- Refresh existing search_index rows by re-firing the AIU trigger.
UPDATE "monitored_domains" SET "updated_at" = "updated_at";
