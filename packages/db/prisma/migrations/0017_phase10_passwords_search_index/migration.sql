-- Phase 10 follow-up: wire the passwords table into `search_index`.
--
-- Mirrors the article/domain pattern in 0009 + 0011:
--
--   * Triggers keep the `password` entity rows in sync on every
--     INSERT/UPDATE/DELETE of a row in `passwords`. The indexed body
--     is deliberately limited to NON-SECRET metadata — name, username,
--     url, tags. Ciphertext columns (`password_ciphertext`,
--     `notes_ciphertext`, `totp_secret_ciphertext`) are never fed into
--     a tsvector because they carry no searchable plaintext and we
--     never want them to leak into a snippet.
--
--   * Visibility: rows with `visible_to_clients = false` get an empty
--     `body_public`, so a CLIENT_USER query (which matches against
--     `body_public_tsv`) can never hit them. SearchService also adds
--     a defensive `visible_to_clients = true` filter for `password`
--     rows, matching the `article`/`domain` rule.
--
--   * Archived rows keep `archived_at` in sync so the global "include
--     archived" toggle + per-row score penalty work uniformly across
--     entity types.
--
-- Backfill is done at the end with `ON CONFLICT DO NOTHING` so this
-- migration is idempotent with any existing partial index state.

-- =====================================================================
-- Trigger functions
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
        "layout_id", "archived_at", "updated_at"
    ) VALUES (
        'password',
        NEW."id",
        NEW."company_id",
        NEW."name",
        CASE WHEN NEW."visible_to_clients" THEN metadata ELSE '' END,
        metadata,
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

CREATE OR REPLACE FUNCTION search_index_delete_password()
RETURNS trigger AS $$
BEGIN
    DELETE FROM "search_index"
    WHERE "entity_type" = 'password' AND "entity_id" = OLD."id";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Triggers
-- =====================================================================

CREATE TRIGGER "passwords_search_index_aiu"
AFTER INSERT OR UPDATE ON "passwords"
FOR EACH ROW EXECUTE FUNCTION search_index_upsert_password();

CREATE TRIGGER "passwords_search_index_ad"
AFTER DELETE ON "passwords"
FOR EACH ROW EXECUTE FUNCTION search_index_delete_password();

-- =====================================================================
-- Backfill existing password rows
-- =====================================================================

INSERT INTO "search_index" (
    "entity_type", "entity_id", "company_id", "title",
    "body_public", "body_internal", "visible_to_clients",
    "layout_id", "archived_at", "updated_at"
)
SELECT
    'password',
    "id",
    "company_id",
    "name",
    CASE
        WHEN "visible_to_clients" THEN trim(
            coalesce("name", '')     || ' ' ||
            coalesce("username", '') || ' ' ||
            coalesce("url", '')      || ' ' ||
            array_to_string(coalesce("tags", ARRAY[]::TEXT[]), ' ')
        )
        ELSE ''
    END,
    trim(
        coalesce("name", '')     || ' ' ||
        coalesce("username", '') || ' ' ||
        coalesce("url", '')      || ' ' ||
        array_to_string(coalesce("tags", ARRAY[]::TEXT[]), ' ')
    ),
    "visible_to_clients",
    NULL,
    "archived_at",
    "updated_at"
FROM "passwords"
ON CONFLICT ("entity_type", "entity_id") DO NOTHING;
