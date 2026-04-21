-- Phase 9b.1: per-user UI preferences (theme + accent).
-- Additive-only. Existing rows default to SYSTEM/LIME so no backfill is
-- required. SYSTEM preserves the previous behaviour for users who never
-- touched the toggle (we respect prefers-color-scheme at paint time).

CREATE TYPE "UiTheme" AS ENUM ('DARK', 'LIGHT', 'SYSTEM');

CREATE TYPE "UiAccent" AS ENUM ('LIME', 'AMBER', 'IRIS', 'CORAL', 'TEAL');

ALTER TABLE "users"
  ADD COLUMN "ui_theme"  "UiTheme"  NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN "ui_accent" "UiAccent" NOT NULL DEFAULT 'LIME';
