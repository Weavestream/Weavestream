-- Instance-wide OIDC single sign-on configuration (additive only; nothing
-- changes at deploy). One row, created on first save, so an install that never
-- opens the tab has no row and SSO stays off.
--
-- Used only when SSO_OIDC_ISSUER is not set in the environment; an
-- env-configured install keeps reading its environment variables.
-- `client_secret_ciphertext` is AES-256-GCM under INTEGRATION_SECRET_KEY (the
-- same mechanism as ai_settings.api_key_ciphertext) and is never returned by
-- the API.
CREATE TABLE "sso_settings" (
    "id"                       TEXT         NOT NULL DEFAULT 'singleton',
    "enabled"                  BOOLEAN      NOT NULL DEFAULT false,
    "provider_name"            TEXT         NOT NULL DEFAULT 'Single sign-on',
    "issuer"                   TEXT,
    "client_id"                TEXT,
    "client_secret_ciphertext" TEXT,
    "scopes"                   TEXT         NOT NULL DEFAULT 'openid profile email',
    "allowed_tenant_id"        TEXT,
    "link_by_email"            BOOLEAN      NOT NULL DEFAULT false,
    "auto_provision"           BOOLEAN      NOT NULL DEFAULT false,
    "trust_idp_mfa"            BOOLEAN      NOT NULL DEFAULT false,
    "local_login_enabled"      BOOLEAN      NOT NULL DEFAULT true,
    "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by"               UUID,

    CONSTRAINT "sso_settings_pkey" PRIMARY KEY ("id")
);
