-- Phase 9a: expand Company with contact, address, classification, logo,
-- and quick notes. Additive-only migration — every new column is
-- nullable (except `type`, which defaults to CLIENT) so existing rows
-- need no backfill.

-- New enum for coarse classification. Kept minimal; widened later if
-- operators ask for it.
CREATE TYPE "CompanyType" AS ENUM (
  'CLIENT',
  'PROSPECT',
  'VENDOR',
  'INTERNAL',
  'PARTNER',
  'OTHER'
);

ALTER TABLE "companies"
  ADD COLUMN "type" "CompanyType" NOT NULL DEFAULT 'CLIENT',
  ADD COLUMN "quick_notes" TEXT,
  ADD COLUMN "parent_company_id" UUID,
  ADD COLUMN "contact_name" TEXT,
  ADD COLUMN "contact_title" TEXT,
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "contact_phone" TEXT,
  ADD COLUMN "general_email" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "fax" TEXT,
  ADD COLUMN "website" TEXT,
  ADD COLUMN "address_line1" TEXT,
  ADD COLUMN "address_line2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "region" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "logo_upload_id" UUID;

-- Parent company is a self-FK. `SET NULL` on delete so archiving or
-- deleting a parent severs the link without cascading to children.
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_parent_company_id_fkey"
  FOREIGN KEY ("parent_company_id") REFERENCES "companies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- One Upload can back at most one company logo. `SET NULL` on delete so
-- a purged Upload row doesn't cascade into losing the whole Company.
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_logo_upload_id_fkey"
  FOREIGN KEY ("logo_upload_id") REFERENCES "uploads"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "companies_logo_upload_id_key"
  ON "companies" ("logo_upload_id");

CREATE INDEX "companies_type_idx" ON "companies" ("type");
CREATE INDEX "companies_parent_company_id_idx"
  ON "companies" ("parent_company_id");
