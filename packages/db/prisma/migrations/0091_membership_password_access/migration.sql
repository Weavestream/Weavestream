-- Company-level password access override (follow-up to issue #110).
-- `inherit` (default) keeps the global password access policy for this
-- member in this company; `allow` / `deny` override it. An entry with its
-- own allow-list still ignores both. Existing memberships get `inherit`,
-- so nothing changes at deploy. No password rows change: the rule is
-- checked at read time.
ALTER TABLE "memberships"
    ADD COLUMN "password_access" TEXT NOT NULL DEFAULT 'inherit';

ALTER TABLE "memberships"
    ADD CONSTRAINT "memberships_password_access_check"
    CHECK ("password_access" IN ('inherit', 'allow', 'deny'));
