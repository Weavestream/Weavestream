-- Alerts feature: user-configurable email alert system.
--
-- Adds:
--   * AlertType enum + alert_config table   — admin-managed alert configurations
--   * alert_trigger table                   — dedup ledger for fired alerts
--   * ALERT_MANAGE capability               — new platform capability
--   * monitored_domains HTTP columns        — drives WEBSITE_DOWN alerts via
--                                              the existing domain checker
--
-- Two execution paths read these tables: a scheduled BullMQ job (alerts:scan)
-- evaluates SINGLE_EXPIRATION / EXPIRATION_LIST / WEBSITE_DOWN, while
-- AlertEmitterService runs synchronously inside AuditLogService.log() to
-- match RECORD_EVENT and PASSWORD_EVENT configs against new audit rows.
-- The alert_trigger UNIQUE(alert_config_id, key) constraint is what makes
-- both paths safe under retry.

-- =====================================================================
-- AlertType enum
-- =====================================================================

CREATE TYPE "AlertType" AS ENUM (
  'SINGLE_EXPIRATION',
  'EXPIRATION_LIST',
  'WEBSITE_DOWN',
  'RECORD_EVENT',
  'PASSWORD_EVENT'
);

-- =====================================================================
-- ALERT_MANAGE capability
-- =====================================================================

ALTER TYPE "PlatformCapability" ADD VALUE 'ALERT_MANAGE';

-- =====================================================================
-- alert_config
-- =====================================================================

CREATE TABLE "alert_config" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"                TEXT         NOT NULL,
    "type"                "AlertType"  NOT NULL,
    "enabled"             BOOLEAN      NOT NULL DEFAULT true,
    "recipient_email"     TEXT         NOT NULL,
    "company_id"          UUID,
    "trigger_days"        INTEGER,
    "stop_after_trigger"  BOOLEAN      NOT NULL DEFAULT true,
    "expiration_kinds"    TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "record_entity_types" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "record_actions"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_by"          UUID,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    "archived_at"         TIMESTAMP(3),

    CONSTRAINT "alert_config_pkey" PRIMARY KEY ("id")
);

-- (type, enabled, archived_at) is the index the AlertEmitterService cache
-- hot-path and the scheduled scan both read from. Filtering by archived
-- state alongside type/enabled keeps the planner from scanning archived
-- rows when refreshing the in-memory cache.
CREATE INDEX "alert_config_type_enabled_archived_at_idx"
  ON "alert_config" ("type", "enabled", "archived_at");
CREATE INDEX "alert_config_archived_at_idx"
  ON "alert_config" ("archived_at");

-- =====================================================================
-- alert_trigger
-- =====================================================================

CREATE TABLE "alert_trigger" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "alert_config_id" UUID         NOT NULL,
    "key"             TEXT         NOT NULL,
    "fired_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_trigger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alert_trigger_alert_config_id_key_key"
  ON "alert_trigger" ("alert_config_id", "key");
CREATE INDEX "alert_trigger_alert_config_id_fired_at_idx"
  ON "alert_trigger" ("alert_config_id", "fired_at");

ALTER TABLE "alert_trigger"
  ADD CONSTRAINT "alert_trigger_alert_config_id_fkey"
  FOREIGN KEY ("alert_config_id") REFERENCES "alert_config" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- monitored_domains HTTP sub-check columns
-- =====================================================================

ALTER TABLE "monitored_domains"
  ADD COLUMN "http_check_enabled" BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN "latest_http_status" INTEGER,
  ADD COLUMN "http_down_since"    TIMESTAMP(3);
