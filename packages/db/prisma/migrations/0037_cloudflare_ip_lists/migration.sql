-- Cloudflare Rules Lists integration — security-kind integration that
-- manages Cloudflare IP allow-lists. One row per registered Cloudflare
-- list; entries are stored as a JSON array (Weavestream is the source
-- of truth; the worker pushes them to Cloudflare via atomic bulk PUT
-- replace).
--
-- Reuses the existing `integrations` row (driver = 'cloudflare') for
-- credentials + cron, so this migration only adds the per-list table
-- and its drift-status enum.

CREATE TYPE "CloudflareDriftStatus" AS ENUM (
  'in_sync',
  'drift_detected',
  'unknown',
  'error'
);

CREATE TABLE "cloudflare_ip_lists" (
    "id"                   UUID                    NOT NULL DEFAULT gen_random_uuid(),
    "integration_id"       UUID                    NOT NULL,
    "external_account_id"  TEXT                    NOT NULL,
    "external_list_id"     TEXT                    NOT NULL,
    "name"                 TEXT                    NOT NULL,
    "description"          TEXT,
    "entries"              JSONB                   NOT NULL DEFAULT '[]'::jsonb,
    "entries_version"      INTEGER                 NOT NULL DEFAULT 1,
    "drift_status"         "CloudflareDriftStatus" NOT NULL DEFAULT 'unknown',
    "drift_details"        JSONB,
    "last_drift_check_at"  TIMESTAMP(3),
    "last_pushed_at"       TIMESTAMP(3),
    "pending_operation_id" TEXT,
    "pending_pushed_at"    TIMESTAMP(3),
    "created_at"           TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3)            NOT NULL,

    CONSTRAINT "cloudflare_ip_lists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cloudflare_ip_lists_integration_external_key"
    ON "cloudflare_ip_lists" ("integration_id", "external_list_id");

CREATE INDEX "cloudflare_ip_lists_integration_idx"
    ON "cloudflare_ip_lists" ("integration_id");

ALTER TABLE "cloudflare_ip_lists"
    ADD CONSTRAINT "cloudflare_ip_lists_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
