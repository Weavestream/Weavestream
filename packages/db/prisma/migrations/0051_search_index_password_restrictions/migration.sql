-- WS-001 residual gap: the search index carried no copy of a
-- password's `restricted_to_user_ids` allow-list, so an internal user
-- (OPERATOR/CONTRACTOR) who is NOT on a restricted credential's
-- allow-list could still surface it (name/username/url/tags in title
-- and snippet) through search and @-mentions. SearchService now
-- filters on this column at the query layer for non-super-admin
-- internal users, mirroring `canReadPassword()`.
--
-- Non-password rows keep the empty-array default and are never
-- restricted by this column.

-- =====================================================================
-- Column
-- =====================================================================

ALTER TABLE "search_index"
    ADD COLUMN "restricted_to_user_ids" UUID[] NOT NULL DEFAULT '{}';

-- =====================================================================
-- Trigger function (replaces the 0017 definition; the triggers created
-- there keep pointing at this function, so no re-CREATE TRIGGER needed)
-- =====================================================================

CREATE OR REPLACE FUNCTION search_index_upsert_password()
RETURNS trigger AS $$
DECLARE
    metadata TEXT;
BEGIN
    -- Build a single plaintext blob from the searchable metadata.
    -- `array_to_string` returns '' for an empty array, so no special
    -- casing is needed when `tags` is empty.
    metadata := trim(
        coalesce(NEW."name", '')     || ' ' ||
        coalesce(NEW."username", '') || ' ' ||
        coalesce(NEW."url", '')      || ' ' ||
        array_to_string(coalesce(NEW."tags", ARRAY[]::TEXT[]), ' ')
    );

    INSERT INTO "search_index" (
        "entity_type", "entity_id", "company_id", "title",
        "body_public", "body_internal", "visible_to_clients",
        "restricted_to_user_ids",
        "layout_id", "archived_at", "updated_at"
    ) VALUES (
        'password',
        NEW."id",
        NEW."company_id",
        NEW."name",
        CASE WHEN NEW."visible_to_clients" THEN metadata ELSE '' END,
        metadata,
        NEW."visible_to_clients",
        coalesce(NEW."restricted_to_user_ids", '{}'),
        NULL,
        NEW."archived_at",
        NEW."updated_at"
    )
    ON CONFLICT ("entity_type", "entity_id") DO UPDATE
    SET "company_id"             = EXCLUDED."company_id",
        "title"                  = EXCLUDED."title",
        "body_public"            = EXCLUDED."body_public",
        "body_internal"          = EXCLUDED."body_internal",
        "visible_to_clients"     = EXCLUDED."visible_to_clients",
        "restricted_to_user_ids" = EXCLUDED."restricted_to_user_ids",
        "archived_at"            = EXCLUDED."archived_at",
        "updated_at"             = EXCLUDED."updated_at";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Backfill existing password rows
-- =====================================================================
-- Must be an UPDATE: the 0017-style `INSERT ... ON CONFLICT DO NOTHING`
-- would skip every existing row and leave restricted credentials
-- unfiltered ('{}' = unrestricted).

UPDATE "search_index" si
SET "restricted_to_user_ids" = p."restricted_to_user_ids"
FROM "passwords" p
WHERE si."entity_type" = 'password'
  AND si."entity_id" = p."id";
