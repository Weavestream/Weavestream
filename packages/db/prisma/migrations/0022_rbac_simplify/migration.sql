-- RBAC simplification — Phase R1
--
-- Background:
--   The RBAC layer had two sources of truth that were drifting from
--   each other: a four-value `MembershipRole` enum and a global
--   `User.role` whose every OPERATOR value implicitly granted "manage"
--   privileges in the UI shells, even when the API matrix denied
--   write actions. This migration collapses the membership enum to
--   `FULL`/`READONLY`, introduces an explicit `User.globalAccess`
--   ternary that drives company-data CRUD when no membership exists,
--   and a granular `User.platformCapabilities` array that replaces the
--   previously SUPER_ADMIN-only platform actions (companies,
--   integrations, layouts, users, memberships, audit, settings,
--   exports). SUPER_ADMIN implicitly holds every capability.
--
-- Migration plan:
--   1) Create the two new enums (`GlobalAccess`, `PlatformCapability`).
--   2) Add `users.global_access` (nullable) and
--      `users.platform_capabilities` (NOT NULL DEFAULT '{}').
--   3) Backfill existing OPERATOR rows with `global_access = 'FULL'`
--      so current operators preserve their company-CRUD power. The
--      capability array stays empty — admins must explicitly grant
--      elevated capabilities post-migration.
--   4) Replace the `MembershipRole` enum: rename the old type, create
--      the new {FULL, READONLY} type, remap rows
--      (`OPERATOR_FULL → FULL`, `OPERATOR_READONLY → READONLY`,
--      `CLIENT_ADMIN → READONLY`, `CLIENT_VIEWER → READONLY` —
--      CLIENT_USER memberships are always read-only in the new model),
--      then drop the old type.
--
-- The CLIENT_USER → FULL invariant and the
-- `non-OPERATOR ⇒ empty platform_capabilities` rule are enforced in
-- the service layer (Zod + UsersService / MembershipsService) rather
-- than via CHECK constraints, so the migration stays reversible.

-- =====================================================================
-- 1. New enums.
-- =====================================================================

CREATE TYPE "GlobalAccess" AS ENUM ('FULL', 'READONLY', 'NONE');

CREATE TYPE "PlatformCapability" AS ENUM (
    'COMPANY_MANAGE',
    'INTEGRATION_MANAGE',
    'LAYOUT_MANAGE',
    'USER_MANAGE',
    'MEMBERSHIP_MANAGE',
    'AUDIT_READ',
    'SETTINGS_MANAGE',
    'EXPORT_CREATE'
);

-- =====================================================================
-- 2. Add the new User columns.
-- =====================================================================

ALTER TABLE "users"
    ADD COLUMN "global_access"         "GlobalAccess",
    ADD COLUMN "platform_capabilities" "PlatformCapability"[] NOT NULL DEFAULT ARRAY[]::"PlatformCapability"[];

-- =====================================================================
-- 3. Backfill: every existing OPERATOR keeps "FULL" by default.
--    SUPER_ADMINs do not need a globalAccess (they implicitly have
--    full access platform-wide); CONTRACTOR / CLIENT_USER never had
--    one. `platform_capabilities` is left empty for every user —
--    elevation is explicit going forward.
-- =====================================================================

UPDATE "users"
   SET "global_access" = 'FULL'::"GlobalAccess"
 WHERE "role" = 'OPERATOR';

-- =====================================================================
-- 4. Collapse MembershipRole to {FULL, READONLY}.
-- =====================================================================

ALTER TYPE "MembershipRole" RENAME TO "MembershipRole_old";

CREATE TYPE "MembershipRole" AS ENUM ('FULL', 'READONLY');

ALTER TABLE "memberships"
    ALTER COLUMN "role" TYPE "MembershipRole"
    USING (
        CASE "role"::text
            WHEN 'OPERATOR_FULL'     THEN 'FULL'::"MembershipRole"
            WHEN 'OPERATOR_READONLY' THEN 'READONLY'::"MembershipRole"
            -- CLIENT_USER memberships are always read-only in the new
            -- model. Even rows that previously carried CLIENT_ADMIN
            -- collapse to READONLY because CLIENT_ADMIN never granted
            -- meaningful CRUD beyond what the API already let
            -- CLIENT_VIEWER do via the per-row `visibleToClients`
            -- filter.
            WHEN 'CLIENT_ADMIN'      THEN 'READONLY'::"MembershipRole"
            WHEN 'CLIENT_VIEWER'     THEN 'READONLY'::"MembershipRole"
        END
    );

DROP TYPE "MembershipRole_old";
