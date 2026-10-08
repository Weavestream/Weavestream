---
label: API Keys
icon: key-asterisk
order: 750
description: Bearer tokens for scripts and AI agents that act as you, with containment for when one leaks.
---

# API Keys

An API key lets a script, integration or AI agent call the Weavestream API as you. A key carries **your** permissions through the normal permission engine; it never has more authority than its owner.

## Turning API keys on

API keys are **off** on a new instance. A user with the settings permission turns them on in **Admin → Settings → Security → Allow API keys**. This asks for MFA again (step-up), and an API key can never change it.

While the switch is off, every request with a key is refused, and no one can create a key. Keys are not deleted, so turning the switch back on restores them.

## Creating a key

**Account → API keys → New API key.** Creating a key asks for your MFA code again (step-up). The key is shown **once**: copy it into your password manager. Weavestream stores only a SHA-256 hash.

Send it on every request:

```http
Authorization: Bearer ws_<keyId>_<secret>
```

| Option | Default | Notes |
|---|---|---|
| Name | required | What will use it, e.g. "MCP on laptop". |
| Expires | 1 year | 30 days, 90 days, 1 year or never (API: `expiresInDays` 1–3650, or `null`). |
| Allow changes | **off** | See below. API: `allowWrite`. |
| Allow password reveal | **off** | See below. API: `allowPasswordReveal`. |

## Read-only by default

A key is **read-only** unless you tick **Allow this key to make changes**. A read-only key gets `403` on every `POST`, `PUT`, `PATCH` and `DELETE`, so a leaked key can read what you can read, but cannot change or delete anything.

The rule is based on the HTTP method, so it also covers endpoints added later. The only exception is password reveal (`POST …/reveal` and `…/totp`), which changes nothing and has its own permission, below.

Give write access only to a script or agent that must create or update records. An AI agent that only answers questions needs a read-only key.

## No per-key scopes yet

A key cannot yet be narrowed to some companies, some record types or some routes. Apart from the two options above, it reaches everything its owner can reach. The API refuses a create request that sends `scopes` with `400` rather than accept a limit it would not enforce.

To give a script less access than you have, create the key from a separate user account with only the permissions the script needs.

## What a key cannot do

A key is contained so that a leaked key is a revocable loss, not an account takeover. Requests made with a key are refused on:

- login, logout, MFA enrolment, step-up, password change and session management
- creating, listing or revoking API keys
- creating, editing, inviting or deactivating users, and resetting their MFA
- changing IP access rules, company memberships and backup destinations
- anything that requires step-up (exports with passwords, backup downloads, integration and email/AI settings)

## Passwords

By default a key can list vault entries but **cannot** reveal passwords, TOTP codes or decrypted notes. Tick **Allow this key to reveal stored passwords** only for a key that genuinely needs it, and never for an AI agent you do not fully control. Reveals made with a key are rate-limited together with your other keys.

## Revocation

Revoke a key from **Account → API keys**. An administrator with the user-management permission can also see and revoke **every** user's key in **Admin → Security center → API keys** (this asks for MFA again). Every key you hold is also revoked automatically when:

- you change your password, or sign out all other sessions
- an admin resets your MFA, re-invites you, or deactivates you
- the `reset-password`, `reset-mfa` or `rotate-sessions` CLI commands run

## Auditing

Every audited action performed with a key records the key's id in the audit log (`apiKeyId`), alongside you as the actor, so a key's activity can be told apart from your own.
