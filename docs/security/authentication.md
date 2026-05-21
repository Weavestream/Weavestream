---
label: Authentication
icon: key
order: 800
description: Login flow, MFA enforcement, session management, and account lockout.
---

# Authentication

## Login Flow

1. User submits email + password at `/login`
2. API validates credentials against the Argon2 hash
3. On success, the server checks for TOTP MFA enrollment
4. User submits their 6-digit TOTP code
5. Server creates a session row (IP, user-agent, expiry) and issues:
   - A **session cookie** (`sameSite=lax`, `httpOnly`, signed with `COOKIE_SIGNING_KEY`)
   - A short-lived **JWT access token** (15-minute TTL, signed with `JWT_SIGNING_KEY`)
6. Subsequent API requests carry the access token; the server validates the JWT and verifies the session row exists and is not revoked

## TOTP MFA

**MFA is mandatory on every account.** There is no way to create a Weavestream account without enrolling an authenticator app.

During account setup (via the one-time setup URL), the user:

1. Scans a QR code displayed inline (generated server-side from the TOTP secret)
2. Enters the current 6-digit code to confirm enrollment

The TOTP secret is encrypted at rest using `MFA_ENCRYPTION_KEY` (AES-256).

> **Backup note.** TOTP secrets, password-vault entries, and SMTP
> credentials are encrypted with keys that live in `.env`
> (`MFA_ENCRYPTION_KEY`, `PASSWORD_ENCRYPTION_KEY`, `SMTP_SECRET_KEY`,
> and so on). A Postgres dump alone is not enough to recover these
> surfaces — the matching key must be present at restore time too.
> Keep `.env` in a separate secrets store, and copy
> `${DATA_DIR}/backup` (the directory the in-app
> [scheduled exports](../deployment/backup.md) write to) off-host on
> the same cadence as `${DATA_DIR}/postgres` and `${DATA_DIR}/files`.

**Supported authenticator apps:** Google Authenticator, Authy, 1Password, Bitwarden, Microsoft Authenticator, and any app that supports the standard TOTP (RFC 6238) protocol.

## MFA Backup Codes

Each account is issued **10 single-use backup codes** that can be used instead of a TOTP code during login. These are useful if your authenticator device is lost or unavailable.

### Format

- 10 characters in the format `XXXXX-XXXXX`
- Alphanumeric (excludes confusing characters: 0, 1, I, O)
- Example: `ABCDE-FGHJ2`

### Storage and Security

- Codes are hashed with Argon2 before storage (same algorithm as passwords)
- Stored in the `user_mfa_backup_codes` table
- Once consumed, a code cannot be reused (marked with `consumedAt` timestamp)

### Usage

During the MFA challenge step at `/mfa/challenge`, enter any valid backup code instead of your 6-digit TOTP code. The code is consumed immediately upon successful login.

### Management

Users can view and regenerate backup codes from **My Account → MFA → Regenerate codes**.

- Regenerating creates a fresh set of 10 codes
- Previous codes are invalidated when you regenerate
- First-time MFA enrollment automatically issues backup codes

## Session Management

Sessions are stored server-side in Redis and referenced by the session cookie. Each session record stores:

- User ID
- IP address at creation
- User-agent string
- Creation timestamp
- Last-used timestamp
- Expiry timestamp
- Revocation flag

**Session TTL** is controlled by `SESSION_MAX_AGE_DAYS` (default: 30 days).

**Access tokens** (JWTs) have a separate TTL of `ACCESS_TOKEN_TTL_MIN` (default: 15 minutes). The web layer refreshes the access token transparently using the session cookie — users are not prompted to re-login within their session window.

## Session Revocation

Sessions can be revoked:

- **By the user** — from **My Account → Sessions**, revoke any specific session
- **By a SUPER_ADMIN** — from the user management page, revoke all sessions for a user

Revocation is **immediate**. The revocation flag is set on the session row; the next API request with that session's token returns 401 and the session cookie is cleared.

JWTs are short-lived (15 minutes), so even if a token is used after revocation, the damage is time-bounded.

## Rate Limiting and Lockout

The login endpoint has two independent protections:

### Per-IP and per-email rate limit

Default: 5 login attempts per minute, per IP address and per email address independently.

If either bucket is exhausted, the endpoint returns 429 with a `Retry-After` header.

Configured via `AUTH_RATE_LIMIT_PER_MIN`.

### Account soft-lock

After `LOCKOUT_MAX_FAILURES` (default: 5) failed attempts within `LOCKOUT_WINDOW_MIN` (default: 15 minutes), the account is soft-locked.

During soft-lock, the login endpoint returns a generic 401 (no information about lock state is revealed). The lock clears automatically after the window expires.

A `SUPER_ADMIN` can clear a lock manually from the user management page.

## Generic Error Responses

All authentication errors return generic 401 responses. The response body does not reveal:

- Whether an account with the given email exists
- Whether the account is locked
- Whether the password was correct (but MFA failed)

This prevents user enumeration and state inference by external attackers.

## Invite-Only Registration

There is no self-registration page. The only way to create an account is for a `SUPER_ADMIN` to:

1. Create the user record in **Admin → Users**
2. Distribute the one-time setup URL (valid for a limited time, single-use)

The setup URL includes a cryptographically random token. When the user opens the URL, they complete account setup (name, password, TOTP enrollment). The token is invalidated after use.

## Password and MFA Recovery

A `SUPER_ADMIN` can generate a one-time password reset link from **Admin → Users → user detail → Generate password reset link**.

The reset link uses the same secure setup-token flow as first-time account setup:

- The user chooses a new password themselves
- Existing unconsumed setup/reset links for that user are invalidated
- The link is single-use and expires after 24 hours
- MFA is cleared and the user re-enrolls an authenticator on the next step

To reset only MFA from the web UI, use **Admin → Users → user detail → Reset MFA**. This clears the user's MFA secret and backup codes, revokes active sessions, and requires the user to enroll MFA again on their next sign-in.

## Super Admin Recovery CLI

If the first or only `SUPER_ADMIN` is locked out, run the CLI from the host running Docker Compose.

Create the initial super admin:

```sh
docker compose exec api node dist/cli.js create-admin
```

Create an additional fail-safe super admin when one already exists:

```sh
docker compose exec api node dist/cli.js create-admin --force
```

Optional non-interactive form:

```sh
docker compose exec api node dist/cli.js create-admin --force --email admin2@example.com --name "Admin 2" --password "StrongPassword123!"
```

Other recovery commands:

```sh
docker compose exec api node dist/cli.js list-users
docker compose exec api node dist/cli.js reset-password user@example.com
docker compose exec api node dist/cli.js reset-mfa user@example.com
```

`reset-password <email>` is CLI-only. It sets a new password directly and revokes that user's sessions. `reset-mfa <email>` clears MFA, removes backup codes, and revokes sessions, matching the web UI reset-MFA behavior.

## "Remember This Device" (Session Persistence)

The login form optionally offers to persist the session for the full `SESSION_MAX_AGE_DAYS` window. Without this option, the session expires when the browser is closed (session-scoped cookie).
