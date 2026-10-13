-- Google Workspace domains feed Domains monitoring.
-- A row the Google sync creates gets source GOOGLE_WORKSPACE; a row it
-- matches (manual or Cloudflare) keeps its source and only gains the
-- workspace_* columns below.
ALTER TYPE "DomainSource" ADD VALUE 'GOOGLE_WORKSPACE';

CREATE TYPE "WorkspaceDomainRole" AS ENUM ('PRIMARY', 'SECONDARY', 'ALIAS');

ALTER TABLE "monitored_domains"
    ADD COLUMN "workspace_integration_id" UUID,
    ADD COLUMN "workspace_role"           "WorkspaceDomainRole",
    ADD COLUMN "workspace_alias_of"       TEXT,
    ADD COLUMN "workspace_synced_at"      TIMESTAMP(3),
    ADD COLUMN "workspace_missing_since"  TIMESTAMP(3);

CREATE INDEX "monitored_domains_workspace_integration_idx"
    ON "monitored_domains"("workspace_integration_id");

-- Deleting the integration keeps the domains; only the link is cleared.
ALTER TABLE "monitored_domains"
    ADD CONSTRAINT "monitored_domains_workspace_integration_id_fkey"
    FOREIGN KEY ("workspace_integration_id") REFERENCES "integrations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
