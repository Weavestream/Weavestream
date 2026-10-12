-- OAuth-connected integrations (one per provider): the integration's OAuth
-- app, and one connection per client tenant. Secrets are stored encrypted;
-- the key never lives in the database.

-- CreateTable
CREATE TABLE "integration_oauth_apps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "integration_id" UUID,
    "client_id" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_oauth_apps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_oauth_apps_provider_key" ON "integration_oauth_apps"("provider");
CREATE UNIQUE INDEX "integration_oauth_apps_integration_id_key" ON "integration_oauth_apps"("integration_id");

-- AddForeignKey
ALTER TABLE "integration_oauth_apps"
    ADD CONSTRAINT "integration_oauth_apps_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_org_id" TEXT NOT NULL,
    "display_name" TEXT,
    "secret_ciphertext" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "connected_by" UUID,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_connections_integration_id_external_org_id_key"
    ON "integration_connections"("integration_id", "external_org_id");

ALTER TABLE "integration_connections"
    ADD CONSTRAINT "integration_connections_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
