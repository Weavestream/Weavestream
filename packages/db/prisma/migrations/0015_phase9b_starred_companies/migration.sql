-- Phase 9b.3: starred companies per user.
-- Powers the operator dashboard "Starred" panel. Independent of
-- Membership so a SUPER_ADMIN can pin any company without holding a
-- per-company role. Unique on (user_id, company_id) so toggling stays
-- idempotent; index on (user_id, created_at DESC) supports the
-- dashboard's ordered listing.

CREATE TABLE "starred_companies" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"    UUID         NOT NULL,
    "company_id" UUID         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starred_companies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "starred_companies_user_id_company_id_key"
  ON "starred_companies" ("user_id", "company_id");

CREATE INDEX "starred_companies_user_id_created_at_idx"
  ON "starred_companies" ("user_id", "created_at");

ALTER TABLE "starred_companies"
  ADD CONSTRAINT "starred_companies_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "starred_companies"
  ADD CONSTRAINT "starred_companies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
