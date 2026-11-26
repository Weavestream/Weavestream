-- OIDC single sign-on (additive only; nothing changes at deploy).
--
-- `user_identities`: links a user to an account at an external identity
--   provider. Unique on (issuer, subject); `subject` is the provider's stable
--   id (`oid` for Microsoft Entra ID, else `sub`). `email` is audit context
--   only. Rows die with the user.
-- `sessions.auth_method`: 'password' (default, every existing session) or
--   'sso'. Drives the step-up factor.
-- `sessions.idp_mfa`: the identity provider vouched for MFA at sign-in and
--   the instance trusts it (SSO_TRUST_IDP_MFA); counts as MFA-complete.
CREATE TABLE "user_identities" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"       UUID         NOT NULL,
    "issuer"        TEXT         NOT NULL,
    "subject"       TEXT         NOT NULL,
    "email"         TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_identities_issuer_subject_key" ON "user_identities"("issuer", "subject");
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

ALTER TABLE "user_identities"
    ADD CONSTRAINT "user_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sessions"
    ADD COLUMN "auth_method" TEXT    NOT NULL DEFAULT 'password',
    ADD COLUMN "idp_mfa"     BOOLEAN NOT NULL DEFAULT false;

-- Prisma has no CHECK support, so this lives in SQL only. Keeps a typo or a
-- future code path from writing a value no guard knows how to treat.
ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_auth_method_check"
    CHECK ("auth_method" IN ('password', 'sso'));
