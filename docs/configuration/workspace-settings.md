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

## Integrations

**Admin > Settings > Integrations** holds the integration priority order: which integration's values win when several sync the same asset. See [Several integrations on one asset](/integrations/#several-integrations-on-one-asset).

### OAuth integrations

Google Workspace and Microsoft 365 connect with a provider sign-in instead of an API key. There is one integration of each per install: its **App** tab holds the OAuth app, and each customer tenant is a row on its **Connections** tab. See [Google Workspace](/integrations/google-workspace/) and [Microsoft 365](/integrations/microsoft-365/).

`API_URL` and `APP_URL` must share a host (for example `APP_URL=https://ws.example.com` and `API_URL=https://ws.example.com/api`). Session cookies are host-only, so on a different API host the browser arrives at the callback signed out and the connect fails. When the hosts differ, the App tab and **Check setup** show "API_URL and APP_URL must share a host for Connect with Google or Microsoft to keep you signed in."

`API_URL` must also use `https://`. Google and Microsoft accept a plain `http://` redirect URI only for `localhost`. On any other host, the App tab and **Check setup** show "API_URL must start with https://."

The client secret is write-only: it is stored AES-256-GCM encrypted under `INTEGRATION_SECRET_KEY` and never shown again; only its last four characters are shown. Saving the app needs the integration management permission and a fresh step-up confirmation, and is recorded as `integration.oauth_app.update`; its Check setup as `integration.oauth_app.check` (outcome and step ids only). Connecting, reconnecting and disconnecting a client tenant are recorded as `integration.oauth.connect`, `integration.oauth.connect.failed` (with a reason category, never the provider's error text) and `integration.oauth.disconnect`, each with the connection id.

## What Settings Don't Change

Workspace settings are **cosmetic only**. The following always remain as-is regardless of configuration:

- URL paths (`/admin/companies/...` — not `/admin/clients/...`)
- API endpoints (`/api/companies/...`)
- Database column names (`companyId`)
- Log messages and audit log entries

This means you can change terminology at any time without breaking bookmarks, integrations, or audit history.
