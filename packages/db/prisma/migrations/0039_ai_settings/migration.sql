-- Global OpenAI-compatible LLM endpoint configuration. The API key is
-- stored as AES-256-GCM ciphertext under INTEGRATION_SECRET_KEY (an LLM
-- endpoint is conceptually one more integration; rotation piggybacks on
-- the existing integrations key) and is never returned by the API.

CREATE TABLE "ai_settings" (
    "id"                  TEXT         NOT NULL DEFAULT 'singleton',
    "enabled"             BOOLEAN      NOT NULL DEFAULT false,
    "base_url"            TEXT,
    "api_key_ciphertext"  TEXT,
    "default_model"       TEXT,
    "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by"          UUID,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ai_settings" ("id")
VALUES ('singleton')
ON CONFLICT ("id") DO NOTHING;
