-- Phase 12+: add TICKETS_READ to the PlatformCapability enum.
-- Read-only global ticket browse across every client visible to the
-- operator. Part of MANAGER_PRESET in the application layer.
ALTER TYPE "PlatformCapability" ADD VALUE IF NOT EXISTS 'TICKETS_READ';
