ALTER TABLE "ai_settings"
  ADD COLUMN "allow_private_network" BOOLEAN NOT NULL DEFAULT false;

-- WS-017: AI calls previously bypassed the SSRF guard unconditionally, so
-- any already-configured deployment may point at a private/LAN endpoint.
-- Backfill the opt-in for those rows to keep them working; the new curated
-- allowlist is still strictly narrower than the old blanket bypass. New
-- rows must opt in explicitly.
UPDATE "ai_settings"
  SET "allow_private_network" = true
  WHERE "enabled" = true AND "base_url" IS NOT NULL;
