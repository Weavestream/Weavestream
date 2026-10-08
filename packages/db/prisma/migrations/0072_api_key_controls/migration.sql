-- API keys are read-only unless a key is minted with write access. Default
-- false so a key leaked from a script or an AI agent's config can read what
-- its owner can read, but cannot change or delete anything.
ALTER TABLE "api_keys"
    ADD COLUMN "allow_write" BOOLEAN NOT NULL DEFAULT false;

-- Instance-wide switch for API key authentication. Default off: an operator
-- turns programmatic access on deliberately from Admin -> Settings ->
-- Security. While off, existing keys are refused (not revoked) and no new
-- key can be created.
ALTER TABLE "system_settings"
    ADD COLUMN "api_keys_enabled" BOOLEAN NOT NULL DEFAULT false;
