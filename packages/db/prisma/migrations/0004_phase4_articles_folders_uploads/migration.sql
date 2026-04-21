-- Phase 4: Articles, folders, uploads.
--
-- All three models are strictly tenant-scoped (see DECISIONS.md D-010).
-- There is no nullable company_id and no "global" escape hatch: an
-- operator who wants a workspace for their own MSP-internal docs creates
-- a regular Company tenant through the admin UI and these rows live
-- under that company's id.
--
-- Thumbnails for image uploads are generated synchronously via `sharp`
-- inside apps/api during Phase 4 (D-011). The BullMQ-driven async
-- variant moves to Phase 7 alongside NinjaOne sync when apps/worker
-- exists.

-- folders (tenant-scoped, self-referential tree)
CREATE TABLE "folders" (
    "id"          UUID NOT NULL,
    "company_id"  UUID NOT NULL,
    "parent_id"   UUID,
    "name"        TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "icon"        TEXT,
    "position"    INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_by"  UUID,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "folders_company_parent_position_idx"
  ON "folders" ("company_id", "parent_id", "position");

-- Active-slug uniqueness within a company+parent. COALESCE the nullable
-- parent_id to a sentinel UUID so the partial unique index treats root
-- folders as a single sibling group.
CREATE UNIQUE INDEX "folders_company_parent_slug_active_uniq"
  ON "folders" ("company_id", COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), "slug")
  WHERE "archived_at" IS NULL;

ALTER TABLE "folders"
  ADD CONSTRAINT "folders_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "folders"
  ADD CONSTRAINT "folders_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "folders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "folders"
  ADD CONSTRAINT "folders_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- articles (tenant-scoped)
CREATE TABLE "articles" (
    "id"                 UUID NOT NULL,
    "company_id"         UUID NOT NULL,
    "folder_id"          UUID,
    "title"              TEXT NOT NULL,
    "slug"               TEXT NOT NULL,
    "content"            JSONB NOT NULL,
    "content_plaintext"  TEXT NOT NULL,
    "excerpt"            TEXT,
    "visible_to_clients" BOOLEAN NOT NULL DEFAULT true,
    "archived_at"        TIMESTAMP(3),
    "created_by"         UUID,
    "updated_by"         UUID,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "articles_company_folder_idx"
  ON "articles" ("company_id", "folder_id");

CREATE INDEX "articles_company_updated_at_idx"
  ON "articles" ("company_id", "updated_at");

-- Active-slug uniqueness per company. Archived rows may reuse a slug
-- once a replacement takes it.
CREATE UNIQUE INDEX "articles_company_slug_active_uniq"
  ON "articles" ("company_id", "slug")
  WHERE "archived_at" IS NULL;

ALTER TABLE "articles"
  ADD CONSTRAINT "articles_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "articles"
  ADD CONSTRAINT "articles_folder_id_fkey"
  FOREIGN KEY ("folder_id") REFERENCES "folders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "articles"
  ADD CONSTRAINT "articles_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "articles"
  ADD CONSTRAINT "articles_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- uploads (tenant-scoped; storage_key is globally unique to prevent
-- accidental key collisions across buckets)
CREATE TABLE "uploads" (
    "id"                UUID NOT NULL,
    "company_id"        UUID NOT NULL,
    "uploader_id"       UUID,
    "filename"          TEXT NOT NULL,
    "mime_type"         TEXT NOT NULL,
    "size_bytes"        INTEGER NOT NULL,
    "storage_key"       TEXT NOT NULL,
    "sha256"            TEXT NOT NULL,
    "is_image"          BOOLEAN NOT NULL DEFAULT false,
    "width"             INTEGER,
    "height"            INTEGER,
    "thumbnail_key"     TEXT,
    "attached_to_type"  TEXT,
    "attached_to_id"    UUID,
    "deleted_at"        TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uploads_storage_key_key"
  ON "uploads" ("storage_key");

CREATE INDEX "uploads_company_image_created_idx"
  ON "uploads" ("company_id", "is_image", "created_at");

CREATE INDEX "uploads_attached_idx"
  ON "uploads" ("attached_to_type", "attached_to_id");

CREATE INDEX "uploads_company_deleted_idx"
  ON "uploads" ("company_id", "deleted_at");

ALTER TABLE "uploads"
  ADD CONSTRAINT "uploads_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uploads"
  ADD CONSTRAINT "uploads_uploader_id_fkey"
  FOREIGN KEY ("uploader_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
