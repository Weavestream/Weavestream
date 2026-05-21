---
label: Users & RBAC
icon: person
order: 780
description: Invite-only user management, forced MFA, and three-axis role-based access control.
---

# Users & Role-Based Access Control

Weavestream uses an invite-only registration flow, mandatory TOTP MFA, and a three-axis RBAC model: global role, default tenant access, and per-tenant memberships. Platform-admin tasks are capability-gated.

## Global Roles

Every user account has one global role:

| Role | Description |
|---|---|
| `SUPER_ADMIN` | Implicit full access to all tenants and all platform capabilities |
| `OPERATOR` | Staff role; tenant access comes from `globalAccess` + explicit memberships |
| `CONTRACTOR` | Per-tenant only, memberships require `expiresAt`, no `globalAccess` or capabilities |
| `CLIENT_USER` | Tenant end-user; read-only only |

## Per-Tenant Memberships (`memberships.role`)

Operators, Contractors, and Client Users are granted tenant access via memberships:

| Membership | Access within the tenant |
|---|---|
| `FULL` | Full read and write |
| `READONLY` | Read-only |

A user can hold memberships in multiple tenants simultaneously with different membership values per tenant.

## Default Tenant Access (`users.globalAccess`)

`globalAccess` applies to `OPERATOR` users on tenants where no explicit membership exists:

| Value | Effect |
|---|---|
| `FULL` | Read/write on unassigned tenants |
| `READONLY` | Read-only on unassigned tenants |
| `NONE` | No access unless explicitly assigned membership |

## Platform Capabilities (`users.platformCapabilities`)

Capabilities gate platform-admin actions:

| Capability | Grants |
|---|---|
| `COMPANY_MANAGE` | Create, edit, archive, and restore tenants |
| `INTEGRATION_MANAGE` | Configure integrations and trigger manual sync runs |
| `LAYOUT_MANAGE` | Create and edit global asset layouts and fields |
| `TAG_MANAGE` | Rename and delete global tags |
| `USER_MANAGE` | Create and edit users |
| `MEMBERSHIP_MANAGE` | Manage tenant memberships |
| `AUDIT_READ` | View the global audit log |
| `SETTINGS_MANAGE` | Edit workspace settings, branding, tenant terminology, and email settings |
| `EXPORT_CREATE` | Trigger company vault-archive PDF exports |
| `ALERT_MANAGE` | Create, edit, and archive alert configurations |
| `SECURITY_READ` | View the Security Center |
| `IP_RULE_MANAGE` | Create, update, and delete global IP allow/deny rules |
| `BACKUP_MANAGE` | Create, edit, run, and download scheduled PostgreSQL backup exports |

`SUPER_ADMIN` has all capabilities implicitly.

## Authorization Resolution

For tenant-scoped checks:

1. `SUPER_ADMIN` => allow.
2. If action requires capability, require it (or `SUPER_ADMIN`) or deny.
3. Active membership (`FULL` / `READONLY`) overrides defaults.
4. Otherwise fall back to `users.globalAccess` for `OPERATOR`.

## Contractor Expiry

`CONTRACTOR` memberships carry an `expiresAt` timestamp. Once the membership expires, any request from that contractor is immediately rejected — no grace period. This is designed for temporary access (e.g. third-party auditors, project-based vendors) without requiring manual revocation.

## Invite-Only Registration

There is no self-registration. A `SUPER_ADMIN` creates a user account and a one-time **Setup Token** is generated. The token is delivered as a URL (e.g. via email, Slack). The recipient:

1. Opens the setup URL
2. Sets their display name and password
3. Enrolls their authenticator app (QR code displayed inline)
4. Completes setup and can log in immediately

Setup tokens are time-limited and single-use.

## Forced TOTP MFA

**Every account requires TOTP MFA.** There is no bypass. MFA enrollment is part of the account setup flow — users cannot complete setup without registering an authenticator app.

## User Account Features

| Feature | Description |
|---|---|
| Display name | Editable from the user's profile page |
| Timezone | Per-user timezone preference for date/time display |
| Theme | Dark, Light, or System |
| Accent colour | Lime, Amber, Iris, Coral, or Teal |
| Session list | View and revoke all active sessions |
| Password change | Change the account password (MFA is still required on next login) |

## Session Management

Each login creates a server-side **Session** record with:

- IP address and user-agent
- Creation, last-used, and expiry timestamps
- Revocation flag

Access tokens (JWTs) are 15 minutes long. Sessions can be revoked immediately from the user's session list or by a `SUPER_ADMIN`. Revocation is instant — the next API call with the revoked session's token is rejected without waiting for JWT expiry.

## Account Deactivation

`SUPER_ADMIN` users can deactivate accounts (`deactivatedAt` timestamp). Deactivated users cannot log in. All their historical data (audit log entries, authored articles) is preserved.

## Rate Limiting & Lockout

The login endpoint has two independent protections:

| Protection | Default |
|---|---|
| Per-IP + per-email rate limit | 5 attempts/minute |
| Account soft-lock after N failures | 5 failures, 15-minute window |

After a soft-lock, the account can only be unlocked by waiting for the window to expire or by a `SUPER_ADMIN` clearing the lock. Generic 401 responses are returned — the error message does not reveal whether an account exists (no user enumeration).
