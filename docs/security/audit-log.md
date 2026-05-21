---
label: Audit Log
icon: list-unordered
order: 600
description: Append-only tamper-resistant mutation history with database-role protection.
---

# Audit Log

Every mutation in Weavestream writes an immutable record to the audit log. The log is accessible to `SUPER_ADMIN` users and is protected at the database-role level against tampering.

## What Is Logged

Every create, update, delete, archive, restore, and sensitive access operation writes an audit entry. This includes:

- **Asset** create, update, archive, restore
- **Password** create, update, archive, restore, **reveal** (each decryption), version restore
- **Article** create, update, move, archive, restore
- **Company** create, update, archive, restore
- **User** create, update, deactivate, role change, password change, MFA reset, invite created/accepted
- **Membership** create, update, revoke
- **Domain** create, update, archive, restore, check result
- **Layout** create, update, rename, archive
- **Settings** update, email update/test
- **Subnet** (IPAM) create, update, archive, restore, reservation CRUD
- **Integration** create, update, delete, secret update, test connection, sync runs, field mappings, asset sync actions
- **Alert** create, update, archive, test, fired
- **Export** PDF vault export triggered, completed, failed
- **Security** session revocation, IP rule CRUD, egress blocks
- **Login** events (success, failure, MFA success/failure, logout, refresh)
- **Auth** MFA enroll/complete, sessions revoke others

## Audit Entry Fields

| Field | Description |
|---|---|
| `id` | Unique entry ID |
| `createdAt` | UTC timestamp |
| `actorId` | User who performed the action |
| `actorEmail` | Email at the time of the action (denormalised) |
| `action` | Action type: `create`, `update`, `delete`, `archive`, `restore`, `reveal`, `login`, etc. |
| `entityType` | Type of record affected: `Asset`, `Password`, `Company`, etc. |
| `entityId` | ID of the specific record |
| `companyId` | Tenant the record belongs to |
| `ip` | Client IP address |
| `userAgent` | Browser or client user-agent |
| `before` | JSON snapshot of the record before the change |
| `after` | JSON snapshot of the record after the change |

For password operations, the `before`/`after` blobs contain metadata only (name, username, URL, tag). Ciphertext is never written to the audit log. Reveal entries log the password ID and actor only — the plaintext is never recorded.

For integration sync operations, tenant-scoped audit rows carry the affected `assetId` and `companyId` so operators can trace which synced records touched their data, even though they cannot manage the integration itself.

For security actions:
- **Session revocation** — `entityId` carries the targeted session; `after.targetUserId` identifies the affected user
- **Egress blocks** — `after` carries `{ url, hostname, resolvedIps, reason, matchedCidr }` for each blocked outbound request
- **IP rules** — changes to global IP allow/deny rules are fully audited with the rule configuration

## Tamper Protection

The audit table is protected at the **Postgres database-role level**:

- The `weavestream` application role has `INSERT` access only to the audit table
- `UPDATE` and `DELETE` are not granted to the application role
- Altering or deleting audit entries requires **Postgres superuser access** — not available through the Weavestream API or admin UI

This provides a meaningful tamper-resistance guarantee for insider threats: even a fully compromised `SUPER_ADMIN` account cannot modify audit history through the application.

The database also installs a `BEFORE UPDATE OR DELETE` trigger named `audit_log_no_update_delete` on `audit_log`. The trigger rejects non-insert row writes with `audit_log is append-only`. `pg_dump` and `pg_restore` are unaffected because they rely on `COPY` and `TRUNCATE`, not per-row `UPDATE` or `DELETE`.

Operators who legitimately need to rewrite audit rows, for example to anonymise a database dump before sharing it, must do so directly as the table owner and should re-enable the trigger immediately afterward:

```sql
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete;
-- ... UPDATE / DELETE statements here ...
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete;
```

## Audit UI

The audit log is accessible at **Admin → Audit**. Features:

- **Server-side cursor pagination** — efficient even for very large audit tables
- **URL-sticky filters** — filter by:
  - Date range
  - Actor (user)
  - Action type
  - Entity type
- **Before/after diff view** — expandable JSON diffs for each entry
- **Configurable page size** — adjust how many entries per page

Filters persist in the URL, making it easy to share a filtered view with colleagues or bookmark for recurring review.

## Password Reveal Audit

Password decryptions are tracked in a dedicated audit category separate from the general mutation log. Each reveal entry records:

- Which password was revealed (by ID and name)
- Which user revealed it
- The timestamp
- The IP address and user-agent

This lets security-conscious operators review who accessed which credentials and when, independent of any UI-level access controls.

## Retention

Audit records are never deleted or archived by the application. There is no built-in retention management.

For long-term compliance requirements, consider:
- Partitioning old audit rows to a cold-storage table
- Exporting audit data periodically via `pg_dump`
- Shipping logs to an external SIEM via Postgres logical replication or a custom script

## Accessing Audit Data Directly

For advanced queries, audit data is in the `AuditLog` table in Postgres:

```sql
-- All password reveals in the last 7 days
SELECT * FROM "AuditLog"
WHERE action = 'password.revealed'
  AND "entityType" = 'Password'
  AND "createdAt" > NOW() - INTERVAL '7 days'
ORDER BY "createdAt" DESC;

-- All mutations by a specific user
SELECT * FROM "AuditLog"
WHERE "actorId" = 'user-uuid-here'
ORDER BY "createdAt" DESC;

-- All security events (session revocations, IP rules, egress blocks)
SELECT * FROM "AuditLog"
WHERE action LIKE 'security.%'
ORDER BY "createdAt" DESC;

-- All integration sync activity affecting a tenant
SELECT * FROM "AuditLog"
WHERE "companyId" = 'tenant-uuid-here'
  AND action LIKE 'integration.%'
ORDER BY "createdAt" DESC;
```

Connect to Postgres with a read-only role for compliance queries to avoid accidentally modifying the data.
