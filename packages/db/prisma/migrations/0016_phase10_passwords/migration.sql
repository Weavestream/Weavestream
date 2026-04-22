-- Phase 10: Password management (encrypted credential vault).
--
-- Three tables + one enum.
--
--   password_folders  — per-company folder tree for grouping
--                       credentials (separate from the article
--                       `folders` tree so archive-cascade logic stays
--                       independent).
--   passwords         — credential records. `password_ciphertext`,
--                       `totp_secret_ciphertext`, and `notes_ciphertext`
--                       are AES-256-GCM blobs written by the API's
--                       SecretEncryptionService (key rotation via
--                       PASSWORD_PREVIOUS_KEYS, same pattern as
--                       JWT_PREVIOUS_KEYS). List endpoints never
--                       return these three columns; detail GETs
--                       decrypt `notes_ciphertext` inline. Reveal of
--                       password + TOTP secret is exclusively through
--                       the audited POST /passwords/:id/reveal route.
--   password_versions — immutable, append-only history of every
--                       credential-field change. `company_id` is
--                       denormalised from the parent (same pattern as
--                       `asset_field_values`) so tenant-middleware
--                       enforces scope without a relational filter.
--
-- Uniqueness on (password_id, version) is enforced so concurrent
-- writers fail fast rather than collapsing history; the service layer
-- computes the next version inside the same transaction as the row
-- update.

-- =====================================================================
-- Enum
-- =====================================================================

CREATE TYPE "TotpAlgo" AS ENUM ('SHA1', 'SHA256', 'SHA512');

-- =====================================================================
-- password_folders
-- =====================================================================

CREATE TABLE "password_folders" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id"  UUID NOT NULL,
    "parent_id"   UUID,
    "name"        TEXT NOT NULL,
    "icon"        TEXT,
    "color"       TEXT,
    "position"    INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_by"  UUID,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "password_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_folders_company_archived_idx"
  ON "password_folders" ("company_id", "archived_at");

CREATE INDEX "password_folders_company_parent_position_idx"
  ON "password_folders" ("company_id", "parent_id", "position");

ALTER TABLE "password_folders"
  ADD CONSTRAINT "password_folders_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_folders"
  ADD CONSTRAINT "password_folders_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "password_folders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "password_folders"
  ADD CONSTRAINT "password_folders_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- passwords
-- =====================================================================

CREATE TABLE "passwords" (
    "id"                      UUID     NOT NULL DEFAULT gen_random_uuid(),
    "company_id"              UUID     NOT NULL,
    "folder_id"               UUID,
    "asset_id"                UUID,
    "name"                    TEXT     NOT NULL,
    "username"                TEXT,
    "url"                     TEXT,
    "notes_ciphertext"        TEXT,
    "password_ciphertext"     TEXT     NOT NULL,
    "totp_secret_ciphertext"  TEXT,
    "totp_algorithm"          "TotpAlgo" NOT NULL DEFAULT 'SHA1',
    "totp_digits"             INTEGER  NOT NULL DEFAULT 6,
    "totp_period"             INTEGER  NOT NULL DEFAULT 30,
    "password_strength"       INTEGER,
    "pwned_count"             INTEGER,
    "pwned_checked_at"        TIMESTAMP(3),
    "last_rotated_at"         TIMESTAMP(3),
    "rotation_reminder_days"  INTEGER,
    "expires_at"              TIMESTAMP(3),
    "color"                   TEXT,
    "tags"                    TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
    "visible_to_clients"      BOOLEAN  NOT NULL DEFAULT false,
    "require_reason_to_view"  BOOLEAN  NOT NULL DEFAULT false,
    "restricted_to_user_ids"  UUID[]   NOT NULL DEFAULT ARRAY[]::UUID[],
    "created_by"              UUID     NOT NULL,
    "updated_by"              UUID     NOT NULL,
    "archived_at"             TIMESTAMP(3),
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "passwords_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "passwords_company_archived_idx"
  ON "passwords" ("company_id", "archived_at");

CREATE INDEX "passwords_company_folder_idx"
  ON "passwords" ("company_id", "folder_id");

CREATE INDEX "passwords_company_asset_idx"
  ON "passwords" ("company_id", "asset_id");

CREATE INDEX "passwords_asset_idx"
  ON "passwords" ("asset_id");

ALTER TABLE "passwords"
  ADD CONSTRAINT "passwords_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "passwords"
  ADD CONSTRAINT "passwords_folder_id_fkey"
  FOREIGN KEY ("folder_id") REFERENCES "password_folders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "passwords"
  ADD CONSTRAINT "passwords_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "passwords"
  ADD CONSTRAINT "passwords_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "passwords"
  ADD CONSTRAINT "passwords_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- password_versions
-- =====================================================================

CREATE TABLE "password_versions" (
    "id"                      UUID     NOT NULL DEFAULT gen_random_uuid(),
    "password_id"             UUID     NOT NULL,
    "company_id"              UUID     NOT NULL,
    "version"                 INTEGER  NOT NULL,
    "name"                    TEXT     NOT NULL,
    "username"                TEXT,
    "url"                     TEXT,
    "notes_ciphertext"        TEXT,
    "password_ciphertext"     TEXT     NOT NULL,
    "totp_secret_ciphertext"  TEXT,
    "totp_algorithm"          "TotpAlgo" NOT NULL DEFAULT 'SHA1',
    "totp_digits"             INTEGER  NOT NULL DEFAULT 6,
    "totp_period"             INTEGER  NOT NULL DEFAULT 30,
    "changed_fields"          TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
    "changed_by"              UUID     NOT NULL,
    "change_reason"           TEXT,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_versions_password_version_uniq"
  ON "password_versions" ("password_id", "version");

CREATE INDEX "password_versions_password_created_idx"
  ON "password_versions" ("password_id", "created_at");

CREATE INDEX "password_versions_company_created_idx"
  ON "password_versions" ("company_id", "created_at");

ALTER TABLE "password_versions"
  ADD CONSTRAINT "password_versions_password_id_fkey"
  FOREIGN KEY ("password_id") REFERENCES "passwords"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_versions"
  ADD CONSTRAINT "password_versions_changed_by_fkey"
  FOREIGN KEY ("changed_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
