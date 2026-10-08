-- Credential reveal is denied to API keys unless explicitly enabled per key.
-- Default false so existing keys (and every key minted without thinking about
-- it) cannot decrypt the vault.
ALTER TABLE "api_keys"
    ADD COLUMN "allow_password_reveal" BOOLEAN NOT NULL DEFAULT false;
