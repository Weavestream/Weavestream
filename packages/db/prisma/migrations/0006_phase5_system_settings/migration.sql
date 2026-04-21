-- Phase 5: singleton settings row that drives workspace branding and the
-- configurable tenant term (Company/Companies → Client/Clients, etc.).
-- Defaults are chosen so a fresh install never shows brand-specific
-- copy in the UI.

CREATE TABLE "system_settings" (
  "id"                     TEXT        NOT NULL DEFAULT 'singleton',
  "workspace_name"         TEXT        NOT NULL DEFAULT 'My Company',
  "workspace_subtitle"     TEXT        NOT NULL DEFAULT 'workspace',
  "tenant_term_singular"   TEXT        NOT NULL DEFAULT 'Company',
  "tenant_term_plural"     TEXT        NOT NULL DEFAULT 'Companies',
  "tenant_term_possessive" TEXT,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  "updated_by"             UUID,

  CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row. Callers always read settings; letting the
-- row not exist on a fresh install would push null-handling into every
-- request path.
INSERT INTO "system_settings" ("id", "updated_at")
VALUES ('singleton', NOW())
ON CONFLICT ("id") DO NOTHING;
