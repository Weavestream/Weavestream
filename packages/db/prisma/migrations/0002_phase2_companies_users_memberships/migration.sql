-- Phase 2: Companies / Users / Memberships / RBAC migration.
-- Additive: new nullable columns, a new table, and a partial unique index
-- that replaces the full-table unique on (user_id, company_id) so historical
-- revoked rows are allowed.

-- Users: soft-deactivation + user profile timezone
ALTER TABLE "users"
  ADD COLUMN "deactivated_at" TIMESTAMP(3),
  ADD COLUMN "timezone" TEXT;

-- Companies: soft-archive + creator attribution
ALTER TABLE "companies"
  ADD COLUMN "archived_at" TIMESTAMP(3),
  ADD COLUMN "created_by" UUID;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Memberships: creator attribution + updated_at; swap full unique for partial.
ALTER TABLE "memberships"
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Drop the old full-table unique on (user_id, company_id); replaced below.
DROP INDEX IF EXISTS "memberships_user_id_company_id_key";

-- Active-only unique: prevents duplicate *live* memberships while allowing
-- historical revoked rows for audit + re-add.
CREATE UNIQUE INDEX "memberships_user_company_active_uniq"
  ON "memberships" ("user_id", "company_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX "memberships_user_id_idx" ON "memberships" ("user_id");

-- UserSetupToken: single-use invite/password-set links.
CREATE TABLE "user_setup_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_setup_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_setup_tokens_token_hash_key" ON "user_setup_tokens"("token_hash");
CREATE INDEX "user_setup_tokens_user_id_idx" ON "user_setup_tokens"("user_id");

ALTER TABLE "user_setup_tokens"
  ADD CONSTRAINT "user_setup_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_setup_tokens"
  ADD CONSTRAINT "user_setup_tokens_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
