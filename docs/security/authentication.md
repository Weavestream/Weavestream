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

Existing backup codes **cannot be viewed**. Only the Argon2 hashes are stored, so
the server cannot reproduce a code once it has been issued — the plaintext is
shown exactly once, at the moment it is generated. If you no longer have your
codes, replace them with a fresh set from **My Account → Security → MFA backup
codes → Regenerate codes**.

- Regenerating creates a fresh set of 10 codes, displayed once
- Previous codes are invalidated when you regenerate
- Regenerating requires a valid recent step-up re-authentication. If your
  session has not confirmed within the step-up window (`STEP_UP_TTL_SEC`,
  15 minutes by default — see [Environment](../configuration/environment.md)),
  you are prompted for a TOTP code or one of your remaining backup codes. This
  is a session-wide window, not a per-action prompt: a session that stepped up
  recently for another sensitive action is not challenged again
- First-time MFA enrollment automatically issues backup codes; the enrollment
  screen's **Continue** button requires confirming you have saved them

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

## Remote AI Connections (OAuth)

AI apps such as Claude and ChatGPT connect to the [MCP endpoint](/integrations/mcp/) at `/mcp` with OAuth. Two separate parts are involved, and only one of them signs anyone in:

| Part | Job | What it checks |
|---|---|---|
| **Weavestream authentication** (this page) | Signs the person in | Password, TOTP MFA, session, step-up |
| **OAuth authorization server** (`/api/v1/oauth/*`) | Issues tokens to the AI app after the person approves | PKCE, the app's identity, the consent decision |

The authorization server has no login form and never sees a password or an MFA code. When it needs a person, it sends the browser to the consent page at `/oauth/consent/…`. That page requires a normal Weavestream session; without one, the person signs in at `/login` (with MFA) and comes back. Approving requires a fresh MFA step-up, the same as creating an [API key](/security/api-keys/).

- **Clients.** An administrator chooses which apps can connect, in **Admin → Settings → API & MCP → Which AI apps can connect** (step-up required, audited as `settings.mcp_client_policy.change`).
  - **Claude and ChatGPT only** (the default): client metadata documents on `chatgpt.com` and `claude.ai`, with return addresses on `chatgpt.com`, `claude.ai` or `claude.com`. No client registration.
  - **Any MCP app**: client metadata documents from any `https` address (verified: the app is shown with that address), and public clients that register themselves through dynamic client registration (unverified: shown as **Not verified**, with no initial access token and no registration management). Registered clients must be public (`token_endpoint_auth_method: none`), use only the authorization code and refresh token grants, and use return addresses that are `https`, or `http` on `127.0.0.1`, `[::1]` or `localhost` (any port, RFC 8252). PKCE is required for every client.
  - Narrowing the choice refuses other apps' connections on their next request without revoking them.
- **Tokens.** Authorization codes, access tokens and refresh tokens are random values stored only as SHA-256 hashes. Access tokens last one hour and are valid only for `https://<instance>/mcp`; the REST API refuses them. Refresh tokens rotate on every use, and a reused one, or a reused code, ends the connection. A connection lasts at most one year.
- **Browser binding.** A consent link works only in the browser that started the authorization, so a link sent to someone else cannot be approved by them for another person's AI app.
- **No second session.** The authorization server's own browser session is never used to skip consent: every authorization needs the person's live Weavestream session.
- **Revocation.** The person revokes a connection under **Account → AI connections**; an administrator under **Security center → AI connections**. Every event that revokes API keys (password change, signing out other sessions, MFA reset, re-invite, deactivation, the recovery CLI commands) revokes AI connections too. Every `/mcp` request and every token refresh checks the connection, the person's account, the **Allow remote AI connections** switch and the client choice above, so a revocation takes effect on the next request.
- **Containment.** A connection has the same limits as an API key on the REST API it reaches internally: no account, user, session or key management, no step-up actions, no password reveal, and read-only unless the person allowed changes.

## Single sign-on (OIDC)

Weavestream can sign people in through an OpenID Connect identity provider, with Microsoft Entra ID as the first target. It is **off by default**. An admin turns it on by setting `SSO_OIDC_ISSUER` (and the client ID and secret) in the environment; see [Environment variables](../configuration/environment.md#single-sign-on-oidc). Password and TOTP sign-in keep working as a break-glass path.

### Sign-in flow

1. The sign-in page asks `GET /api/v1/auth/sso/config` (public, no secrets) and shows **Sign in with &lt;SSO_PROVIDER_NAME&gt;** when SSO is on.
2. `GET /api/v1/auth/sso/login` sends the browser to the provider with an authorization-code request: PKCE (`S256`), a random `state` and a random `nonce`, all from `crypto.randomBytes`. The three values travel in one signed, `HttpOnly`, `SameSite=Lax` cookie that lives 10 minutes and is cleared on return. Over https it is named `__Host-ws_sso_flow` (Secure, Path=/, no Domain, so a sibling subdomain cannot plant it); over plain http (local development only) it is `ws_sso_flow`. The signed payload also carries a fixed purpose string, separate for sign-in and step-up, that is checked on return.
3. The provider returns the browser to `GET /api/v1/auth/sso/callback`. The API compares `state` in constant time, exchanges the code over the back channel (with a timeout), and verifies the ID token before reading any claim from it.
4. On success the person gets the **same session** as a password sign-in (same refresh-token rotation, access cookie, CSRF cookie and appearance cookie) and is redirected to `/`. On any failure the browser goes to `/login?sso_error=<code>` with one of four fixed codes: `no_account`, `not_allowed`, `failed`, `expired`. The redirect target is always the configured `APP_URL`, never a value from the request, and the detail stays in the server log and the audit trail.

The sign-in start and callback routes use the same rate limit as password sign-in (`AUTH_RATE_LIMIT_PER_MIN`).

### ID token checks

| Check | Rule |
|---|---|
| Signature | Verified against the issuer's published keys (discovery document, cached). Only `RS256`, `ES256` and `PS256` are accepted; `none` and the HMAC algorithms are refused. |
| `iss` | Must equal `SSO_OIDC_ISSUER` exactly. The discovery document must also describe that issuer. |
| `aud` | Must contain the client ID (and, with several audiences, `azp` must be the client ID). |
| `exp`, `iat`, `sub` | Required; 60 seconds of clock skew allowed. |
| `nonce` | Must equal the nonce from the flow cookie (constant time). |
| `tid` | When `SSO_ALLOWED_TENANT_ID` is set, must equal it. |

A multi-tenant issuer (`/common`, `/organizations`, `/consumers`, or the personal-accounts tenant id `9188040d-6c67-4c5b-b112-36a304b66dad`) is refused at startup. In a multi-tenant endpoint the email address in a token is not proof of identity, so matching by email there would allow account takeover.

### Which Weavestream user signs in

- A user is matched by a stored link `(issuer, subject)`, never by email once linked. For an Entra issuer (`login.microsoftonline.com`) the subject is the object ID (`oid`) and a token without one is refused, so the subject cannot flip between `oid` and `sub`. Other providers use `sub`. Links are stored in `user_identities` and are removed with the user.
- **First sign-in, no link.** Auto-linking by email is **off by default** (`SSO_LINK_BY_EMAIL=false`), because an email address is only as trustworthy as the provider's verification of it. With it on, the person is linked to the existing user whose `email` claim matches (case-insensitively) only when all of these hold: the token proves the email is verified (`email_verified` is `true`, or the Entra `xms_edov` claim is `true`; an absent claim is not verified); the user is active; the user has a password set (an unaccepted invite is never linked); and the user is not a `SUPER_ADMIN` and has no platform capabilities (those are never auto-linked). Only the `email` claim is used, never `preferred_username`. A user already linked to another account at the same issuer is not given a second one. For Entra, normally enable the optional `xms_edov` claim on the application, or skip auto-linking and use `SSO_AUTO_PROVISION` and an administrator to grant access. Every refusal shows the person the same `not_allowed` (or `no_account`) page; the real reason is only in the audit row and server log. A successful link is audited as `auth.sso.link`.
- **Nobody matches.** With `SSO_AUTO_PROVISION=true` an Operator with global access **None** and no memberships is created (audited as `auth.sso.provision`); otherwise the person sees `no_account`.
- A deactivated user is refused (`not_allowed`) even when already linked.

### Multi-factor authentication

- By default Weavestream's own rules apply after SSO: a user without TOTP is sent to enrollment, and a user with TOTP is challenged.
- With `SSO_TRUST_IDP_MFA=true`, an ID token whose `amr` claim contains `mfa` makes that **session** multi-factor complete (`sessions.idp_mfa`). Nothing is written to the user's own MFA state, so a password sign-in for the same person is still held to the TOTP rules. The setting is checked on every request, so turning it off ends the exemption for sessions that already exist. Only enable this when the provider genuinely enforces MFA for this application (for Entra, with a Conditional Access policy that requires it).

### Step-up for sensitive actions

Sensitive actions ask for a recent re-authentication (the window is `STEP_UP_TTL_SEC`, see [Environment](../configuration/environment.md)). Which credential is requested depends on the session:

| Session | Factor |
|---|---|
| Account has TOTP enabled | `mfa`: a TOTP or backup code, as before |
| SSO session, no TOTP | `sso`: the browser is sent to `GET /api/v1/auth/sso/step-up`, which re-authenticates at the provider with `prompt=login` and `max_age=0` |
| Password session, no TOTP | `password`, as before |

For the `sso` factor the callback accepts the result only when the ID token carries an `auth_time` within the last 120 seconds, belongs to the account that owns the session, and the session is still live. The provider must therefore include `auth_time` in the ID token: in Entra, add it as an optional claim on the application. A token without it is refused.

### Turning off password sign-in

`SSO_LOCAL_LOGIN=false` makes `POST /auth/login` refuse everyone except `SUPER_ADMIN`. The refusal is the same generic 401 as a wrong password, still spends one Argon2 verification, and counts toward the failure lockout. Password sessions that already exist stop working for every non-`SUPER_ADMIN` user on their next request (SSO sessions and `SUPER_ADMIN` sessions are unaffected). The `SUPER_ADMIN` exception exists so a broken identity provider cannot lock every administrator out. One carve-out remains: the one-time invite link still accepts a new password, but under this setting the session it creates is refused for a non-`SUPER_ADMIN`, so the invitee has to sign in through SSO afterwards.

### Setting up Microsoft Entra ID

1. In the Entra admin center, register an application (single tenant).
2. Add a **Web** redirect URI: `<API_URL>/v1/auth/sso/callback`.
3. Create a client secret and keep its value (it is shown once).
4. Add the optional ID-token claims `auth_time` (needed for step-up) and, if you turn on `SSO_LINK_BY_EMAIL`, `email` and `xms_edov` (the email's domain owner verification; without it no one is auto-linked).
5. Set `SSO_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`, `SSO_OIDC_CLIENT_ID` and `SSO_OIDC_CLIENT_SECRET`, then restart the API.
6. Optionally require assignment on the enterprise application so that only assigned people can sign in (an unassigned person is returned as `not_allowed`).

### Linking your own account (self-service)

Auto-linking by email is off by default and never applies to `SUPER_ADMIN` accounts or accounts with platform capabilities, so those people link their provider account themselves, signed in:

1. Sign in (password and TOTP) and open **My account → Security → Single sign-on** (shown only when SSO is on).
2. Choose **Link &lt;provider&gt; account**. Weavestream asks for a fresh step-up first (a TOTP or backup code if you have TOTP, otherwise your password).
3. The browser goes to the provider (`GET /api/v1/auth/sso/link`, with `prompt=select_account` so you can pick the account) and returns to **My account** with the result.

Rules the API enforces:

- Interactive sessions only (no API keys or AI connections), MFA complete, rate-limited, and a recent step-up. Requests the browser marks as cross-site (`Sec-Fetch-Site: cross-site`) are refused.
- The flow is bound to your user and your session in a signed cookie with its own purpose string (`weavestream.sso.link.v1`). When the provider returns, the session must still be live, unrevoked and yours, you must still be active, and the step-up window must still be open.
- The link uses only the verified `(issuer, subject)`. The email claim is not read, so it works for any role and for providers that do not send a verified email. It creates no session and does not change your current one.
- It is refused (shown as "could not be linked") when that provider account is already linked to any user, including you, or when you already have a linked account at this provider. Unlink first to switch.
- Audited as `auth.sso.link` with reason `self_service`, plus short hashes of the subject and email, never raw values.

To remove the link, choose **Unlink** (confirmation and a fresh step-up required; `DELETE /api/v1/auth/sso/link`, audited as `auth.sso.unlink`). It is refused when it would leave the account with no way to sign in: the user has no password, or password sign-in is off for them (`SSO_LOCAL_LOGIN=false` and not `SUPER_ADMIN`). `GET /api/v1/auth/sso/link/status` returns `{ enabled, linked, providerName }` for the signed-in user. Existing SSO sessions are not ended by an unlink.

### Audit

| Action | When |
|---|---|
| `auth.sso.login.success` | An SSO session was created (`after` carries `idpMfa`, `amrPresent` and `idpMfaAsserted` (did the provider send an `amr` claim at all, and was it accepted as MFA), `mfaPending`, `mfaSetupRequired`). |
| `auth.sso.login.failure` | Any refusal; `after.reason` is a fixed code. |
| `auth.sso.link` | A user was linked to a provider account: on first sign-in by email, or by the user themselves (`reason: self_service`). |
| `auth.sso.unlink` | A user removed their link, or was refused because it would lock them out (`after.refused`). |
| `auth.sso.provision` | First sign-in created a user. |
| `auth.sso.stepup` | A provider re-authentication opened the step-up window. |

Authorization codes, tokens, the client secret and claim sets are never logged or audited.

## Rate Limiting and Lockout

The login endpoint has two independent protections:

### Per-(IP, email) rate limit

Default: 5 login attempts per minute per (IP address, email address) pair. Users behind a shared egress IP (e.g. an office NAT) each get their own bucket for their own email; requests without a usable email in the body share a single per-IP bucket.

When a bucket is exhausted, the endpoint returns 429 with a `Retry-After-auth` header.

Configured via `AUTH_RATE_LIMIT_PER_MIN`. Independent per-IP and per-email limits on *failed* attempts are enforced separately by the account soft-lock below, which also stops single-IP password spraying across many emails.

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

!!!tip Command fails or the prompts don't appear?
If you get a permission error talking to the Docker daemon, your shell user isn't in the `docker` group — prefix the command with `sudo`. `create-admin` (without `--force --email ... --password ...`) is interactive, so if you're running it via plain `docker exec` instead of `docker compose exec`, add `-it`: `docker exec -it <container> node dist/cli.js create-admin`.
!!!

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
