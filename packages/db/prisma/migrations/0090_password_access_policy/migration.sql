-- Global password access policy (issue #110). Existing instances keep
-- today's rule (every internal user with company access can open an entry
-- that has no own allow-list) through the default. No password rows change:
-- the policy is checked at read time.
ALTER TABLE "system_settings"
    ADD COLUMN "password_access_mode" TEXT NOT NULL DEFAULT 'all_users',
    ADD COLUMN "password_access_user_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_password_access_mode_check"
    CHECK ("password_access_mode" IN ('all_users', 'selected_users'));
