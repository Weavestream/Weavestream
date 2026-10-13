-- Microsoft 365 domains feed Domains monitoring, like Google Workspace.
-- A row the Microsoft sync creates gets source MICROSOFT_365; a row it
-- matches (manual, Cloudflare or Google) keeps its source and only gains
-- the microsoft_* columns below.
ALTER TYPE "DomainSource" ADD VALUE 'MICROSOFT_365';

CREATE TYPE "MicrosoftDomainAuthType" AS ENUM ('MANAGED', 'FEDERATED');

ALTER TABLE "monitored_domains"
    ADD COLUMN "microsoft_integration_id" UUID,
    ADD COLUMN "microsoft_default"        BOOLEAN,
    ADD COLUMN "microsoft_auth_type"      "MicrosoftDomainAuthType",
    ADD COLUMN "microsoft_services"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "microsoft_synced_at"      TIMESTAMP(3),
    ADD COLUMN "microsoft_missing_since"  TIMESTAMP(3);

CREATE INDEX "monitored_domains_microsoft_integration_idx"
    ON "monitored_domains"("microsoft_integration_id");

-- Deleting the integration keeps the domains; only the link is cleared.
ALTER TABLE "monitored_domains"
    ADD CONSTRAINT "monitored_domains_microsoft_integration_id_fkey"
    FOREIGN KEY ("microsoft_integration_id") REFERENCES "integrations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
