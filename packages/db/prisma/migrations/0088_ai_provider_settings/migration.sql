-- Settings → AI: explicit provider, background model, reasoning effort,
-- and the optional Anthropic workspace id.
--
-- `provider` replaces host sniffing and decides the wire format, auth
-- headers and request shaping:
--   openai             api.openai.com (Chat Completions, Bearer)
--   anthropic          api.anthropic.com (x-api-key + anthropic-version)
--   openai_compatible  everything else (Ollama, LM Studio, vLLM, routers);
--                      the pre-0088 behavior, kept exactly.
-- `background_model` serves titles, the tool-intent prelude and article
-- summaries; NULL falls back to `default_model`.
-- `reasoning_effort` is a target the server maps per model family;
-- 'default' sends no reasoning parameter in chat (today's request shape).
-- `anthropic_workspace_id` is not a secret; it is sent as the
-- `anthropic-workspace-id` header for keys not scoped to a workspace.
ALTER TABLE "ai_settings"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'openai_compatible',
  ADD COLUMN "background_model" TEXT,
  ADD COLUMN "reasoning_effort" TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN "anthropic_workspace_id" TEXT,
  ADD CONSTRAINT "ai_settings_provider_check"
    CHECK ("provider" IN ('openai', 'anthropic', 'openai_compatible')),
  ADD CONSTRAINT "ai_settings_reasoning_effort_check"
    CHECK ("reasoning_effort" IN ('default', 'off', 'low', 'medium', 'high')),
  ADD CONSTRAINT "ai_settings_anthropic_workspace_id_check"
    CHECK ("anthropic_workspace_id" IS NULL
      OR "anthropic_workspace_id" ~ '^[A-Za-z0-9_-]{1,128}$');

-- Existing rows keep working: a saved first-party URL gets its provider,
-- everything else stays openai_compatible.
UPDATE "ai_settings"
  SET "provider" = 'anthropic'
  WHERE "base_url" ~* '^https://api\.anthropic\.com(:443)?(/|$)';
UPDATE "ai_settings"
  SET "provider" = 'openai'
  WHERE "base_url" ~* '^https://api\.openai\.com(:443)?(/|$)';
