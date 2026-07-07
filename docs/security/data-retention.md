---
label: Data Retention
icon: database
order: 650
description: Where derived plaintext copies of records live (search, audit, versions, backups) and how to remediate them.
---

# Data Retention

Weavestream keeps several **secondary stores** that hold data derived from your
primary records — the search index, the audit log, article version history, and
backup dumps. These stores exist for good reasons (fast search, tamper-evident
history, point-in-time recovery), but they mean that **hiding or deleting a
value in the primary UI does not automatically remove every copy of it.**

This page answers one operator question:

> If I hide or delete some content, where might a plaintext copy still live, and
> how do I remediate it?

The existence of these copies is by design. This page documents what enters each
store, what redaction already applies, and the concrete cleanup path for each.

## Secondary-Store Matrix

| Store | What enters it | Redaction / minimization | On hide/delete of source | Retention |
|---|---|---|---|---|
| **Search index** (`search_index`) | Asset field text (incl. `visibleToClients=false` fields in the internal body); full article plaintext; password **metadata only** (name/username/URL/tags — never secrets); upload filenames | Split into `body_public` / `body_internal`; per-row `visible_to_clients`; password `restricted_to_user_ids` allow-list; non-searchable field types excluded | Index row is rewritten on every edit; row removed on hard delete; archived rows excluded from client results | Lives as long as the source row; rebuilt by `reindex-search` |
| **Audit log** (`audit_log`) | `before`/`after` JSON snapshots. Assets store full `fieldValues` (incl. hidden fields); passwords and articles store curated metadata only | DB-enforced append-only; `logChange()` writes only changed fields and skips no-op updates; passwords/articles hand-curate secret-free payloads | **Not removed** — the log is append-only by design | Never auto-pruned; operator-managed (see [Audit Log](/security/audit-log/)) |
| **Article versions** (`article_versions`) | Full article body per revision — `content` (Tiptap JSON), `markdownSource`, `contentPlaintext`, plus title/slug/folder/visibility | Per-version `visibleToClients` snapshot, enforced against the *version's own* flag for client reads; no-op edits skip; drafts coalesce into one row | Cascade-deleted when the article is purged | One row per saved revision; no retention cap |
| **Backup dumps** (`$DATA_DIR/backup`) | A `pg_dump` of the whole database — plaintext for everything except vault ciphertext (which stays encrypted) | Backup retention policy (keep-last / daily / weekly / monthly) | A dump taken before deletion still contains the deleted data | Pruned per the configured retention policy |
| **Redis** (`$DATA_DIR/redis`) | Sessions, BullMQ job payloads, throttle/lockout counters, caches | TTL-based expiry; no long-term persistence of record content | Keys expire on their TTL; job payloads are transient | Short-lived |
| **File store** (`$DATA_DIR/files`) | Upload originals, thumbnails, company logos, export PDFs | Per-tenant directory isolation; path-traversal controls | File is deleted with its parent record | Lives with the source record |

## What Each Store Retains

### Search index

The `search_index` table denormalizes searchable content so full-text queries do
not touch the source tables. Each row carries two body columns:

- **`body_public`** — the client-visible representation. For assets it contains
  only fields marked `visibleToClients=true`; for articles it is populated only
  when the article itself is client-visible; for passwords it is empty when the
  password is not client-visible.
- **`body_internal`** — the operator representation. For assets this includes the
  text of **all** searchable fields, *including those marked
  `visibleToClients=false`*. For articles it always carries the full plaintext.

Read-time access control is applied in `SearchService.search()`: client users
query `body_public` only, non-visible article/password rows are refused, and the
password `restricted_to_user_ids` allow-list is enforced for internal users (see
WS-001 in the security history). Field types that should never be indexed (files,
Vaultwarden links, asset references) are excluded from both bodies.

**Passwords never place secret values in the index** — only non-secret metadata
(name, username, URL, tags) is indexed.

**Remediation:** the index is rewritten whenever the source record is edited. To
rebuild the entire index from the current source rows (for example after a scrub
of the underlying data), run:

```bash
docker compose exec api node dist/cli.js reindex-search
```

See [Search](/features/search/) for how the index is scoped and queried.

### Audit log

The audit log records `before`/`after` JSON snapshots for every mutation. Most
callers minimize what they store:

- **Passwords** log metadata only — name, username, URL, visibility flags, and a
  boolean `hasTotp`. Plaintext passwords, notes, and TOTP secrets are **never**
  written to the audit log.
- **Articles** log a curated field set (title, slug, folder, visibility, editor
  mode) — the article body is not copied into the audit log.
- **Assets** currently store the full `fieldValues` map in both `before` and
  `after`, including the content of fields marked `visibleToClients=false`. This
  is a known, accepted plaintext copy (see the callout below).

The audit log is **append-only at the database-role level** — the application
role can `INSERT` but not `UPDATE` or `DELETE`, and a trigger rejects row
mutations. Removing or redacting an audit row therefore cannot be done through
the app; it requires direct table-owner access.

**Remediation:** to scrub sensitive content that was accidentally entered, an
operator with table-owner access temporarily disables the immutability trigger,
edits the rows, and re-enables it. The exact procedure is documented in
[Audit Log → Tamper Protection](/security/audit-log/).

### Article versions

Every saved revision of an article persists a full body snapshot
(`content`, `markdownSource`, `contentPlaintext`) plus its title, slug, folder,
and a per-version `visibleToClients` flag. Client-facing history reads gate on
**the version's own** visibility flag, not the article's current flag, so making
an article public does not retroactively expose historically-hidden revisions.

No-op edits do not create a version, and the live autosave draft coalesces into a
single row rather than one per keystroke.

**Remediation:** article versions are cascade-deleted when the article is purged.
There is no per-version retention cap; to remove a specific historical body an
operator must purge the article or edit the `article_versions` rows directly.

### Backups

Database backups are `pg_dump` outputs written under `$DATA_DIR/backup`. A dump
is a plaintext copy of the whole database (vault ciphertext remains encrypted),
so **a backup taken before you deleted or redacted data still contains that
data.** Backups are pruned according to the configured keep-last / daily /
weekly / monthly retention policy.

**Remediation:** rotate out old dumps per the retention policy and re-take a
fresh dump after any scrub. Treat dump files as sensitive artifacts. See
[Backups](/deployment/backup/) for the retention configuration and
[Encryption](/security/encryption/) / WS-007 for at-rest encryption expectations.

### Redis and the file store

Redis holds transient operational data (sessions, queue jobs, throttle counters,
caches) that expires on a TTL and does not retain record content long-term. The
file store holds upload originals, thumbnails, logos, and export PDFs under
per-tenant directories; files are removed with their parent record.

## Accepted Plaintext Copies

!!!warning Known and accepted
Two secondary copies of asset data are **plaintext by design** and are tracked as
accepted risk (finding WS-004), not gaps closed here:

- **Asset `fieldValues` in the audit log** — `before`/`after` snapshots include
  the content of hidden (`visibleToClients=false`) fields.
- **Hidden asset field text in `search_index.body_internal`** — excluded from the
  client-facing `body_public`, but retained in the operator body.

Both are readable to operators with database or `AUDIT_READ` access and are
captured in backups. They are not encrypted at the application layer — see the
["Not encrypted at rest"](/security/encryption/) list.
!!!

## Related Documentation

- [Audit Log](/security/audit-log/) — append-only history and tamper protection
- [Encryption](/security/encryption/) — what is and is not encrypted at rest
- [Search](/features/search/) — how the search index is scoped and queried
- [Backups](/deployment/backup/) — backup contents and retention policy
- [Client Portal](/features/client-portal/) — client visibility controls
