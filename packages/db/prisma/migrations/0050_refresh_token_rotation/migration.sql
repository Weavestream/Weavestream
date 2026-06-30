-- Refresh token rotation + single-generation reuse detection.
--
-- `previous_refresh_token_hash` holds the SHA-256 hash of the
-- immediately-prior refresh token after a rotation; `rotated_at` records
-- when that rotation happened. Presenting the previous token within a
-- short, server-owned grace window is a benign concurrent refresh;
-- presenting it after that window is treated as reuse/theft -> the session
-- is revoked and a security event is audited.
--
-- Both columns are nullable and additive, so there is no backfill: existing
-- sessions keep their current `refresh_token_hash` (still matched on the
-- active lookup) and simply begin rotating on their next refresh. No one is
-- logged out by this migration.
ALTER TABLE "sessions"
ADD COLUMN "previous_refresh_token_hash" TEXT,
ADD COLUMN "rotated_at" TIMESTAMP(3);

-- Distinct 256-bit random tokens never collide and Postgres treats NULLs as
-- distinct, so a unique index is safe and enables a direct lookup by the
-- previous-token hash.
CREATE UNIQUE INDEX "sessions_previous_refresh_token_hash_key" ON "sessions"("previous_refresh_token_hash");
