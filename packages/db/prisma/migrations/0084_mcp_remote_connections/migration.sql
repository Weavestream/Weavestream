-- Remote MCP: connections a user approved through OAuth, the authorization
-- server's storage, the instance switch, and audit attribution.
CREATE TABLE "mcp_connections" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"       UUID         NOT NULL,
    "client_id"     TEXT         NOT NULL,
    "client_name"   TEXT         NOT NULL,
    "redirect_host" TEXT         NOT NULL,
    "grant_id"      TEXT         NOT NULL,
    "allow_write"   BOOLEAN      NOT NULL DEFAULT false,
    "last_used_at"  TIMESTAMP(3),
    "expires_at"    TIMESTAMP(3) NOT NULL,
    "revoked_at"    TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_connections_grant_id_key" ON "mcp_connections"("grant_id");
CREATE INDEX "mcp_connections_user_revoked_idx" ON "mcp_connections"("user_id", "revoked_at");

ALTER TABLE "mcp_connections"
    ADD CONSTRAINT "mcp_connections_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "oauth_artifacts" (
    "id"          TEXT         NOT NULL,
    "kind"        TEXT         NOT NULL,
    "payload"     JSONB        NOT NULL,
    "grant_id"    TEXT,
    "uid"         TEXT,
    "expires_at"  TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "oauth_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "oauth_artifacts_grant_id_idx" ON "oauth_artifacts"("grant_id");
CREATE INDEX "oauth_artifacts_uid_idx" ON "oauth_artifacts"("uid");
CREATE INDEX "oauth_artifacts_expires_at_idx" ON "oauth_artifacts"("expires_at");

ALTER TABLE "system_settings"
    ADD COLUMN "mcp_remote_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "audit_log"
    ADD COLUMN "mcp_connection_id" UUID;
