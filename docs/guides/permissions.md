---
label: Permissions & RBAC
icon: shield
order: 800
description: Assign roles and manage user access across global and per-tenant scopes.
---

# Permissions & RBAC

Weavestream uses three orthogonal RBAC axes: a **global role**, a per-user **default tenant access** (`globalAccess`), and **per-tenant memberships**. Platform-admin actions are gated by **capabilities**. All authorization is evaluated from a single resolver.

## RBAC Model

```
User account
├── Global role (SUPER_ADMIN / OPERATOR / CONTRACTOR / CLIENT_USER)
├── Default tenant access (OPERATOR only: FULL / READONLY / NONE)
├── Platform capabilities (OPERATOR only)
└── Per-tenant memberships (FULL / READONLY)
```

## Global Roles

| Role | What they can do |
|---|---|
| `SUPER_ADMIN` | Full access to all tenants and all platform capabilities |
| `OPERATOR` | Staff role; tenant access comes from `globalAccess` + explicit memberships |
| `CONTRACTOR` | Per-tenant only, memberships require `expiresAt`, no capabilities or `globalAccess` |
| `CLIENT_USER` | Tenant end-user; read-only only |

## Membership Roles (`memberships.role`)

| Membership | Read | Write |
|---|---|---|
| `FULL` | ✓ | ✓ |
| `READONLY` | ✓ | ✗ |

An explicit membership overrides default tenant access for that tenant.

## Default Tenant Access (`users.globalAccess`)

Only applies to `OPERATOR` users when they do **not** have an explicit membership for a tenant.

| Value | Effect |
|---|---|
| `FULL` | Read/write on unassigned tenants |
| `READONLY` | Read-only on unassigned tenants |
| `NONE` | No access unless explicitly assigned membership |

## Platform Capabilities (`users.platformCapabilities`)

Capabilities gate platform-admin tasks. `SUPER_ADMIN` has all capabilities implicitly.

| Capability | Grants |
|---|---|
| `COMPANY_MANAGE` | Create, edit, archive, and restore tenants |
| `INTEGRATION_MANAGE` | Configure integrations and trigger manual sync runs |
| `LAYOUT_MANAGE` | Create and edit global asset layouts and fields |
| `TAG_MANAGE` | Rename and delete global tags |
| `USER_MANAGE` | Create and edit users; promotion to/from `SUPER_ADMIN` remains `SUPER_ADMIN`-only |
| `MEMBERSHIP_MANAGE` | Manage tenant memberships across any tenant |
| `AUDIT_READ` | View the global audit log |
| `SETTINGS_MANAGE` | Edit workspace settings, branding, tenant terminology, and email settings |
| `EXPORT_CREATE` | Trigger company vault-archive PDF exports |
| `ALERT_MANAGE` | Create, edit, and archive alert configurations |
| `SECURITY_READ` | View the Security Center: login activity, lockouts, throttle blocks, egress blocks, and cross-user sessions |
| `IP_RULE_MANAGE` | Create, update, and delete global IP allow/deny rules |
| `BACKUP_MANAGE` | Create, edit, run, and download scheduled PostgreSQL backup exports |

The manager preset grants common operational capabilities (`COMPANY_MANAGE`, `INTEGRATION_MANAGE`, `LAYOUT_MANAGE`, `TAG_MANAGE`, `USER_MANAGE`, `MEMBERSHIP_MANAGE`, `AUDIT_READ`, `SECURITY_READ`, `IP_RULE_MANAGE`). Sensitive capabilities such as `SETTINGS_MANAGE`, `EXPORT_CREATE`, `ALERT_MANAGE`, and `BACKUP_MANAGE` should be granted deliberately.

## Assigning Global Roles

Global roles are set when creating a user account from **Admin → Users → New User**. They can be changed later by a `SUPER_ADMIN` from the user's profile page.

!!!warning Changing a global role
Changing a user from `OPERATOR` to `CLIENT_USER` revokes all their operator memberships. The change takes effect on the next API request — active sessions are not immediately invalidated.
!!!

## Granting Tenant Access

1. Navigate to **Admin → Memberships** or the tenant's **Members** page
2. Click **Add Member**
3. Search for the user by name or email
4. Select `FULL` or `READONLY`
5. For Contractors: set an `expiresAt` date

The user gains access immediately.

## Removing Tenant Access

1. Open the membership from **Admin → Memberships** or the tenant's **Members** page
2. Click **Remove**

Access is revoked on the next API request. There is no grace period.

## Contractor Expiry

When a `CONTRACTOR` membership reaches its `expiresAt` timestamp, every subsequent API request from that user returns a `403 Forbidden` response. The user's account remains active — they can still log in — but all tenant access is blocked.

To extend a contractor's access, update the `expiresAt` date on their membership.

## `SUPER_ADMIN` Access

`SUPER_ADMIN` users do not need memberships — they have unrestricted access to all tenants automatically. You cannot grant a `SUPER_ADMIN` a per-tenant membership (it would be redundant).

## Visibility Flags vs RBAC

RBAC controls **who can access which tenant**. Visibility flags (`visibleToClients`) control **what content within a tenant** a client user can see.

Both layers are enforced server-side.

## Resolution Order

For tenant-scoped checks, the resolver evaluates in this order:

1. `SUPER_ADMIN` => allow.
2. If action requires a capability, require it (or `SUPER_ADMIN`) or deny.
3. Active tenant membership (`FULL` / `READONLY`) overrides default access.
4. Fall back to `users.globalAccess` for `OPERATOR` users.

## Recommended Setup for an MSP

| User type | Global role | Memberships |
|---|---|---|
| Internal IT lead | `SUPER_ADMIN` | — (unrestricted) |
| Internal technician | `OPERATOR` | `FULL` on assigned clients (`globalAccess=NONE`) |
| External auditor | `CONTRACTOR` | `READONLY` on relevant clients, with expiry date |
| Client contact | `CLIENT_USER` | `READONLY` on their tenant |
| Senior operator | `OPERATOR` | `FULL` where needed + selected platform capabilities |
