-- API keys: long-lived, user-scoped credentials for programmatic access.
-- Authenticate as the creating user; cascade-deleted with them.
CREATE TABLE "api_keys" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"      UUID         NOT NULL,
    "key_id"       TEXT         NOT NULL,
    "token_hash"   TEXT         NOT NULL,
    "name"         TEXT         NOT NULL,
    "scopes"       TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at"   TIMESTAMP(3),
    "revoked_at"   TIMESTAMP(3),
    "created_by"   UUID,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_key_id_key" ON "api_keys"("key_id");
CREATE INDEX "api_keys_user_revoked_idx" ON "api_keys"("user_id", "revoked_at");

ALTER TABLE "api_keys"
    ADD CONSTRAINT "api_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
