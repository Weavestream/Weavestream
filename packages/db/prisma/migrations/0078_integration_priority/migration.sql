-- Integration priority order: which integration's values win when several
-- integrations are bound to one asset. NULL keeps the built-in default order.
ALTER TABLE "system_settings"
    ADD COLUMN "integration_priority" JSONB;
