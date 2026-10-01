---
label: API Keys
icon: key-asterisk
order: 750
description: Bearer tokens for scripts and AI agents that act as you, with containment for when one leaks.
---

# API Keys

An API key lets a script, integration or AI agent call the Weavestream API as you. A key carries **your** permissions through the normal permission engine; it never has more authority than its owner.

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
| Allow password reveal | **off** | See below. |

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

Revoke a key from **Account → API keys**. Every key you hold is also revoked automatically when:

- you change your password, or sign out all other sessions
- an admin resets your MFA, re-invites you, or deactivates you
- the `reset-password`, `reset-mfa` or `rotate-sessions` CLI commands run

## Auditing

Every audited action performed with a key records the key's id in the audit log (`apiKeyId`), alongside you as the actor, so a key's activity can be told apart from your own.
