-- Phase 10 follow-up: workspace-wide defaults for the client-side
-- password generator. The column is JSONB so we can extend the shape
-- without a migration; the API layer validates it through
-- `passwordGeneratorDefaultsSchema` on every read. NULL is a valid
-- "not yet configured" state — the service falls back to
-- `DEFAULT_PASSWORD_GENERATOR_DEFAULTS` so a fresh install never
-- surfaces null to the UI.

ALTER TABLE "system_settings"
    ADD COLUMN "password_generator_defaults" JSONB;
