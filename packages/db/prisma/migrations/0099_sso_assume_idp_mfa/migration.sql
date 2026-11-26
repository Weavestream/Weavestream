-- Opt-in: treat every SSO sign-in as multi-factor complete, for providers that
-- enforce MFA by policy but do not send the `amr` claim (additive only; the
-- default is false, so nothing changes at deploy). Only has effect while
-- `trust_idp_mfa` is also true.
ALTER TABLE "sso_settings"
    ADD COLUMN "assume_idp_mfa" BOOLEAN NOT NULL DEFAULT false;
