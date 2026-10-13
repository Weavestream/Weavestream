-- Instance OAuth apps: the client secret expiry date the operator enters
-- (warned 30 days ahead) and, for Microsoft, the operator's own directory
-- (tenant) id that Check setup mints a client-credentials token against.
ALTER TABLE "integration_oauth_apps"
    ADD COLUMN "secret_expires_at" DATE,
    ADD COLUMN "tenant_id"         TEXT;
