-- Phase 3: Asset layouts, assets, and polymorphic relations.
--
-- Layouts are global (no company_id) — every company shares the same
-- catalog (see DECISIONS.md D-007 layouts-are-global). Only SUPER_ADMIN
-- can mutate layouts; all other roles have read access.
--
-- The Relation table is scaffolded here and auto-populated by the
-- FieldTypeStrategy for ASSET_REFERENCE fields; no Relation API/UI
-- ships until Phase 5.

-- FieldType enum
CREATE TYPE "FieldType" AS ENUM (
  'TEXT',
  'TEXTAREA',
  'RICH_TEXT',
  'NUMBER',
  'DATE',
  'DATETIME',
  'BOOLEAN',
  'DROPDOWN',
  'MULTISELECT',
  'EMAIL',
  'PHONE',
  'URL',
  'ASSET_REFERENCE',
  'VAULTWARDEN_LINK',
  'FILE',
  'TAGS'
);

-- asset_layouts (global; no company_id)
CREATE TABLE "asset_layouts" (
    "id"          UUID NOT NULL,
    "name"        TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "icon"        TEXT NOT NULL,
    "color"       TEXT NOT NULL,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "version"     INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_by"  UUID,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_layouts_pkey" PRIMARY KEY ("id")
);

-- Active-slug uniqueness: archived layouts can reuse a slug once restored
-- safely elsewhere (or a new layout can take the slug while the old one
-- stays archived).
CREATE UNIQUE INDEX "asset_layouts_slug_active_uniq"
  ON "asset_layouts" ("slug")
  WHERE "archived_at" IS NULL;

ALTER TABLE "asset_layouts"
  ADD CONSTRAINT "asset_layouts_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- asset_fields
CREATE TABLE "asset_fields" (
    "id"                     UUID NOT NULL,
    "asset_layout_id"        UUID NOT NULL,
    "name"                   TEXT NOT NULL,
    "slug"                   TEXT NOT NULL,
    "field_type"             "FieldType" NOT NULL,
    "position"               INTEGER NOT NULL,
    "is_required"            BOOLEAN NOT NULL DEFAULT false,
    "is_unique_per_company"  BOOLEAN NOT NULL DEFAULT false,
    "visible_to_clients"     BOOLEAN NOT NULL DEFAULT true,
    "is_primary"             BOOLEAN NOT NULL DEFAULT false,
    "options"                JSONB NOT NULL DEFAULT '{}',
    "archived_at"            TIMESTAMP(3),
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_fields_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_fields_asset_layout_id_position_idx"
  ON "asset_fields" ("asset_layout_id", "position");

-- Active-slug uniqueness within a layout.
CREATE UNIQUE INDEX "asset_fields_layout_slug_active_uniq"
  ON "asset_fields" ("asset_layout_id", "slug")
  WHERE "archived_at" IS NULL;

-- At most one primary field per layout (active).
CREATE UNIQUE INDEX "asset_fields_layout_primary_active_uniq"
  ON "asset_fields" ("asset_layout_id")
  WHERE "is_primary" = true AND "archived_at" IS NULL;

ALTER TABLE "asset_fields"
  ADD CONSTRAINT "asset_fields_asset_layout_id_fkey"
  FOREIGN KEY ("asset_layout_id") REFERENCES "asset_layouts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- assets (tenant-scoped)
CREATE TABLE "assets" (
    "id"               UUID NOT NULL,
    "company_id"       UUID NOT NULL,
    "asset_layout_id"  UUID NOT NULL,
    "name"             TEXT NOT NULL,
    "external_id"      TEXT,
    "external_source"  TEXT,
    "archived_at"      TIMESTAMP(3),
    "created_by"       UUID,
    "updated_by"       UUID,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assets_company_id_asset_layout_id_archived_at_idx"
  ON "assets" ("company_id", "asset_layout_id", "archived_at");

CREATE INDEX "assets_company_id_name_idx"
  ON "assets" ("company_id", "name");

CREATE INDEX "assets_company_id_updated_at_idx"
  ON "assets" ("company_id", "updated_at");

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- onDelete: Restrict — layouts with any asset cannot be hard-deleted,
-- only archived. This matches the Phase 3 plan's archive/restore flow.
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_asset_layout_id_fkey"
  FOREIGN KEY ("asset_layout_id") REFERENCES "asset_layouts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- asset_field_values
CREATE TABLE "asset_field_values" (
    "id"              UUID NOT NULL,
    "asset_id"        UUID NOT NULL,
    "asset_field_id"  UUID NOT NULL,
    "value"           JSONB NOT NULL,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_field_values_asset_id_asset_field_id_key"
  ON "asset_field_values" ("asset_id", "asset_field_id");

CREATE INDEX "asset_field_values_asset_field_id_idx"
  ON "asset_field_values" ("asset_field_id");

ALTER TABLE "asset_field_values"
  ADD CONSTRAINT "asset_field_values_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_field_values"
  ADD CONSTRAINT "asset_field_values_asset_field_id_fkey"
  FOREIGN KEY ("asset_field_id") REFERENCES "asset_fields"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- relations (polymorphic; source/target can be any entity type)
CREATE TABLE "relations" (
    "id"            UUID NOT NULL,
    "company_id"    UUID NOT NULL,
    "source_type"   TEXT NOT NULL,
    "source_id"     UUID NOT NULL,
    "target_type"   TEXT NOT NULL,
    "target_id"     UUID NOT NULL,
    "relation_type" TEXT NOT NULL,
    "created_by"    UUID,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "relations_source_target_type_uniq"
  ON "relations" ("source_type", "source_id", "target_type", "target_id", "relation_type");

CREATE INDEX "relations_company_source_idx"
  ON "relations" ("company_id", "source_type", "source_id");

CREATE INDEX "relations_company_target_idx"
  ON "relations" ("company_id", "target_type", "target_id");

ALTER TABLE "relations"
  ADD CONSTRAINT "relations_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "relations"
  ADD CONSTRAINT "relations_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
