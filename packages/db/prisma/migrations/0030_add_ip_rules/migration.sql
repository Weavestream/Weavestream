-- Phase 5: IP allow/deny rules.
--
-- Adds:
--   * IpRuleAction enum + ip_rules table  — admin-managed IP rules
--   * IP_RULE_MANAGE capability            — new platform capability
--
-- Enforced globally before authentication by IpRuleGuard.

-- =====================================================================
-- IpRuleAction enum
-- =====================================================================

CREATE TYPE "IpRuleAction" AS ENUM (
  'ALLOW',
  'DENY'
);

-- =====================================================================
-- IP_RULE_MANAGE capability
-- =====================================================================

ALTER TYPE "PlatformCapability" ADD VALUE 'IP_RULE_MANAGE';

-- =====================================================================
-- ip_rules
-- =====================================================================

CREATE TABLE "ip_rules" (
    "id"         UUID           NOT NULL DEFAULT gen_random_uuid(),
    "cidr"       TEXT           NOT NULL,
    "action"     "IpRuleAction" NOT NULL,
    "note"       TEXT,
    "priority"   INTEGER        NOT NULL DEFAULT 0,
    "enabled"    BOOLEAN        NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3)   NOT NULL,

    CONSTRAINT "ip_rules_pkey" PRIMARY KEY ("id")
);

-- (enabled, priority) is the index the IpRuleGuard reads from.
-- Rules are ordered by priority ascending; the first matching rule wins.
CREATE INDEX "ip_rules_enabled_priority_idx"
  ON "ip_rules" ("enabled", "priority");
