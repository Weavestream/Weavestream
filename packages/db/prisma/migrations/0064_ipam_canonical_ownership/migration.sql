-- CR-017: canonical active-CIDR ownership must be a database invariant.
--
-- The original partial unique index compared the user-facing TEXT value. That
-- leaves equivalent spellings (for example a host-bit representation written
-- outside the API) as distinct keys. Keep the display value, but derive an
-- immutable PostgreSQL network key and enforce active ownership against it.

BEGIN;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;

-- Hold writers across duplicate validation and index replacement. Without
-- this lock, a legacy process could commit an equivalent spelling after the
-- check but before the canonical index exists and make deployment fail.
LOCK TABLE "subnets" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "subnets"
  ADD COLUMN "canonical_cidr" inet
  GENERATED ALWAYS AS (network("cidr"::inet)) STORED;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "subnets"
    WHERE "archived_at" IS NULL
    GROUP BY "company_id", "canonical_cidr"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'CR-017 cannot install canonical CIDR ownership: equivalent active subnet rows already exist; archive or merge duplicates first';
  END IF;
END $$;

-- Bring any valid legacy host-bit spellings back to the application-facing
-- canonical form before enforcing the literal/prefix checks.
UPDATE "subnets"
SET "cidr" = "canonical_cidr"::text,
    "prefix" = masklen("canonical_cidr")
WHERE "cidr" IS DISTINCT FROM "canonical_cidr"::text
   OR "prefix" IS DISTINCT FROM masklen("canonical_cidr");

ALTER TABLE "subnets"
  ADD CONSTRAINT "subnets_cidr_canonical_check"
    CHECK (
      family("canonical_cidr") = 4
      AND "cidr" = "canonical_cidr"::text
      AND "prefix" = masklen("canonical_cidr")
    );

DROP INDEX "subnets_company_cidr_active";

CREATE UNIQUE INDEX "subnets_company_canonical_cidr_active"
  ON "subnets" ("company_id", "canonical_cidr")
  WHERE "archived_at" IS NULL;

COMMIT;
