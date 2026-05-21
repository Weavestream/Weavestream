---
label: Starred Items
icon: star
order: 870
description: Bookmark assets, passwords, articles, and companies for instant access from the sidebar.
---

# Starred Items

Starred items give you a personalised shortcut list — accessible from the admin sidebar and dashboard — so you can jump straight to the records you work with most often.

## Supported Record Types

Starring is available on all major record types:

| Type | Where to star |
|---|---|
| **Companies** | Company detail page |
| **Assets** | Asset detail page |
| **Passwords** | Password detail page |
| **Articles** | Article detail and edit pages |

## Accessing Your Stars

Starred records appear in two places:

- **Sidebar starred drawer** — click the star icon in the left navigation to open a panel listing all your starred items, grouped by type with type-specific icons and tenant context.
- **Admin dashboard** — a starred items widget on the dashboard for quick access without opening the drawer.

Each entry shows the record name, the tenant it belongs to, and an archived-state label if the record has been soft-deleted.

## Managing Stars

- **Star** a record by clicking the star icon on its detail page. The action is instant and doesn't require a page reload.
- **Unstar** by clicking the same icon again.
- Stars are **per-user** — each operator maintains their own list independently.
- If a starred record is deleted (hard delete), the star entry is automatically removed via cascade.

## API

Stars are managed through the `/me/stars` API:

- `GET /me/stars` — returns a single mixed list of all starred records for the authenticated user.
- `POST /me/stars/:type/:id` — star a record (idempotent).
- `DELETE /me/stars/:type/:id` — unstar a record.

Supported `:type` values: `company`, `asset`, `password`, `article`.
