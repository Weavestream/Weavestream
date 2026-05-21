---
label: Workspace Settings
icon: paintbrush
order: 800
description: UI-level workspace branding and terminology configuration.
---

# Workspace Settings

Workspace settings are managed from **Admin → Settings** by a `SUPER_ADMIN`. These settings control the name and vocabulary used throughout the UI — no code changes or container restarts are required.

The values are stored in a singleton `system_settings` row. They affect UI copy only; they do not rename routes, API paths, database columns, or RBAC keys.

## Workspace Name

The **workspace name** appears in the top-left sidebar chip on every admin page. Set it to your organisation's name, product name, or however you want the platform identified to your users.

**Examples:** `Acme IT`, `Helpdesk`, `InfraBase`, `MyMSP`

## Workspace Subtitle

A short **subtitle** appears as muted text below the workspace name in the sidebar. This is typically a descriptor like `workspace`, `documentation`, or `IT portal`.

## Tenant Terminology

The word used for "tenant" everywhere in the UI is configurable. This is the term used in:

- Sidebar navigation labels
- Button and dialog titles
- Breadcrumbs and page headings
- Empty state messages
- Help text

### Presets

| Preset | Singular | Plural | Possessive |
|---|---|---|---|
| Company | Company | Companies | Company's |
| Client | Client | Clients | Client's |
| Department | Department | Departments | Department's |
| Tenant | Tenant | Tenants | Tenant's |
| Organisation | Organisation | Organisations | Organisation's |
| Site | Site | Sites | Site's |
| Custom | (your term) | (your plural) | (your possessive) |

The **Custom** option lets you enter any term for singular, plural, and possessive forms independently.

## Stored Settings

| Setting | Shown in | Default |
|---|---|---|
| Workspace name | Sidebar chip at the top of every admin page | `My Company` |
| Workspace subtitle | Muted text below the workspace name | `workspace` |
| Tenant term, singular | Buttons, dialog titles, help text, empty states | `Company` |
| Tenant term, plural | Sidebar navigation, breadcrumbs, column headers, page titles | `Companies` |
| Tenant term, possessive | Phrases such as "this client's assets" | `Company's` |

### Live Preview

The settings page includes a **live preview** that updates in real time as you type. The preview shows:

- The sidebar navigation with your term applied
- Example dialog titles ("New [Client]", "Edit [Client]")
- Empty state copy ("No [clients] yet")

This lets you see exactly how the UI will look before saving.

## Password Generator Defaults

Workspace-wide defaults for the [password generator](/features/passwords/#password-generator):

| Setting | Description |
|---|---|
| Default mode | Words + symbols, Passphrase, or Custom length |
| Minimum length | Minimum characters (for custom length mode) |
| Word separator | Character used between words in passphrase mode |

These defaults are used when the generator is opened without user-specific preferences. Users can override them per-session.

## What Settings Don't Change

Workspace settings are **cosmetic only**. The following always remain as-is regardless of configuration:

- URL paths (`/admin/companies/...` — not `/admin/clients/...`)
- API endpoints (`/api/companies/...`)
- Database column names (`companyId`)
- Log messages and audit log entries

This means you can change terminology at any time without breaking bookmarks, integrations, or audit history.
