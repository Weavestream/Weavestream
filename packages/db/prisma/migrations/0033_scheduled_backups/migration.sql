-- Scheduled Postgres export feature.
--
-- Adds:
--   * BACKUP_MANAGE capability            — new platform capability
--   * backup_config table                 — one row per schedule
--   * backup_run table                    — one row per attempt
--   * BackupRunKind / BackupRunStatus enums
--
-- Does NOT touch the filesystem — the dumps themselves land on the
-- host via a bind mount added in compose.yml
-- (`${DATA_DIR}/backup:/var/lib/weavestream/backup`). Operators must
-- back up both `${DATA_DIR}/backup` and `${DATA_DIR}/files` to
-- survive a host loss; the application layer only owns the metadata
-- rows in this migration.

-- =====================================================================
-- BACKUP_MANAGE capability
-- =====================================================================

ALTER TYPE "PlatformCapability" ADD VALUE 'BACKUP_MANAGE';

-- =====================================================================
-- BackupRunKind / BackupRunStatus enums
-- =====================================================================

CREATE TYPE "BackupRunKind" AS ENUM (
  'SCHEDULED',
  'MANUAL'
);

CREATE TYPE "BackupRunStatus" AS ENUM (
  'queued',
  'running',
  'success',
  'failed'
);

-- =====================================================================
-- backup_config
-- =====================================================================

CREATE TABLE "backup_config" (
    "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"               TEXT         NOT NULL,
    "enabled"            BOOLEAN      NOT NULL DEFAULT true,
    "cron"               TEXT         NOT NULL,
    "timezone"           TEXT,
    "retention"          JSONB        NOT NULL,
    "notify_emails"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "notify_on_success"  BOOLEAN      NOT NULL DEFAULT false,
    "last_run_at"        TIMESTAMP(3),
    "created_by"         UUID,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_config_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_config_enabled_idx" ON "backup_config" ("enabled");

-- =====================================================================
-- backup_run
-- =====================================================================

CREATE TABLE "backup_run" (
    "id"            UUID              NOT NULL DEFAULT gen_random_uuid(),
    "config_id"     UUID,
    "kind"          "BackupRunKind"   NOT NULL,
    "status"        "BackupRunStatus" NOT NULL DEFAULT 'queued',
    "started_at"    TIMESTAMP(3),
    "finished_at"   TIMESTAMP(3),
    "size_bytes"    BIGINT,
    "manifest"      JSONB,
    "dump_path"     TEXT,
    "manifest_path" TEXT,
    "error"         TEXT,
    "triggered_by"  UUID,
    "created_at"    TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_run_config_id_started_at_idx"
  ON "backup_run" ("config_id", "started_at" DESC);
CREATE INDEX "backup_run_status_created_at_idx"
  ON "backup_run" ("status", "created_at");

ALTER TABLE "backup_run"
  ADD CONSTRAINT "backup_run_config_id_fkey"
  FOREIGN KEY ("config_id") REFERENCES "backup_config" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
