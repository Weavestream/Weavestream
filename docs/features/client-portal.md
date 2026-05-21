---
label: Client Portal
icon: browser
order: 720
description: Read-only per-tenant portal for client users, with server-side field scoping.
---

# Client Portal

Each tenant in Weavestream has a dedicated **Client Portal** — a read-only interface where `CLIENT_USER` accounts can view the data their operator has chosen to share with them.

## URL Structure

The client portal is accessible at:

```
https://your-instance.com/portal/<company-slug>
```

Each tenant has a unique slug. Client users are granted access to specific companies via [Memberships](/features/users/).

## What Client Users Can See

Client users only see content explicitly marked as visible to them. Everything else is stripped server-side before the response.

| Section | Visibility control |
|---|---|
| Articles | Articles with `visibleToClients = true` |
| Assets | Asset records, with fields where `visibleToClients = true` |
| Passwords | Passwords with `visibleToClients = true` (if the user has the right role) |
| Domains | Domains with `visibleToClients = true` |
| Photos | Gallery of uploaded images |

## Server-Side Field Scoping

Field-level visibility is enforced on the **server**. When an asset record is fetched for the client portal, all fields marked `visibleToClients = false` are stripped from the response payload before it is sent to the browser. This prevents a client from seeing sensitive fields even if they inspect network traffic.

## Client Portal Roles

| Role | Access |
|---|---|
| `CLIENT_ADMIN` | Can view all client-visible content and manage other client users within their tenant |
| `CLIENT_VIEWER` | Read-only access to all client-visible content |

## Authentication

Client users log in through the same login form as operators, at `/login`. After authentication, they are redirected to their portal. Client users cannot access the admin interface — any attempt to navigate to `/admin` routes returns a 403.

Forced TOTP MFA applies to all accounts, including client users.

## Credential Access in the Portal

Passwords marked `visibleToClients` are accessible in the portal for users with the appropriate role. The same access controls apply as in the admin vault:

- Reveal audit trail (every decryption logged)
- Optional reason-to-view prompt
- User whitelist restrictions

## Customising What Clients See

From the admin interface, operators control visibility per entity:

- **Articles** — toggle `visibleToClients` on each article
- **Asset fields** — toggle `visibleToClients` per field in the layout builder
- **Passwords** — toggle `visibleToClients` per password record
- **Domains** — toggle `visibleToClients` per domain

No code changes or separate content management is required — it is all configured through the existing admin UI.
