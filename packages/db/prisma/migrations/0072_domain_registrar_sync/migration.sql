-- Cloudflare registrar sync for monitored domains.
CREATE TYPE "DomainSource" AS ENUM ('MANUAL', 'CLOUDFLARE');

ALTER TABLE "monitored_domains"
    ADD COLUMN "source"                  "DomainSource" NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN "integration_id"          UUID,
    ADD COLUMN "cloudflare_account_id"   TEXT,
    ADD COLUMN "registrar"               TEXT,
    ADD COLUMN "registrar_auto_renew"    BOOLEAN,
    ADD COLUMN "registrar_locked"        BOOLEAN,
    ADD COLUMN "registrar_registered_at" TIMESTAMP(3),
    ADD COLUMN "registrar_expires_at"    TIMESTAMP(3),
    ADD COLUMN "registrar_statuses"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "nameservers"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "registrar_synced_at"     TIMESTAMP(3),
    ADD COLUMN "registrar_missing_since" TIMESTAMP(3);

CREATE INDEX "monitored_domains_integration_idx" ON "monitored_domains"("integration_id");

-- Deleting an integration must not delete the domains it discovered; they
-- revert to orphaned-but-kept rows the operator can archive deliberately.
ALTER TABLE "monitored_domains"
    ADD CONSTRAINT "monitored_domains_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
