import { ApiError, apiFetch } from './api';

/**
 * Auth-flow calls, deliberately outside TanStack Query.
 *
 * Everything here handles its own 401 locally — a wrong password or a
 * wrong MFA code is a 401 that must show inline, not bounce the user to
 * the login screen. Staying out of Query is what makes that structural
 * rather than a rule someone has to remember (see `query-client.ts`).
 */

export interface LoginResponse {
  mfaSetupRequired: boolean;
  mfaChallengeRequired: boolean;
  user: { id: string; email: string };
}

export type LoginOutcome =
  | { kind: 'ok' }
  | { kind: 'mfa-challenge' }
  | { kind: 'mfa-setup' }
  | { kind: 'error'; message: string };

/**
 * Turn a failed auth call into copy the user can act on.
 *
 * The distinction matters more than it looks. Reporting every failure as
 * "invalid credentials" sends a technician to re-type a password they
 * got right — and during an API outage or on a dead radio, that is
 * exactly when they are least able to tell the difference. Only a 401
 * actually means the credential was wrong.
 *
 * `rejected` is the caller's wording for that one case ("Invalid
 * credentials." vs "Invalid code."); everything else is shared.
 */
function authError(err: unknown, rejected: string): string {
  if (!(err instanceof ApiError)) {
    // Transport failure: no response at all.
    return 'Can’t reach Weavestream. Check your connection.';
  }
  if (err.status === 429) return 'Too many attempts. Try again later.';
  if (err.status === 401) return rejected;

  // 400 is INPUT VALIDATION, not a wrong secret — and on the MFA path it
  // is easy to hit: `MfaVerifyDto` only accepts a 6-digit TOTP or a
  // 10-character backup code, so a half-typed or mis-typed code is
  // rejected by the DTO before the code is ever compared. The server's
  // own message ("token must be a 6-digit code or backup code") is more
  // useful than anything generic, so surface it when it is presentable.
  if (err.status === 400) {
    const detail = problemDetail(err.problem);
    return detail || 'Check the format and try again.';
  }

  if (err.status >= 500) {
    return 'Weavestream is having trouble. Try again in a moment.';
  }
  return 'Something went wrong. Try again.';
}

/**
 * Pull a displayable sentence out of an RFC-7807 body.
 *
 * Guarded on length and shape: `detail` is server-authored and safe to
 * render as text, but a validation body can carry a long joined list, and
 * a wall of text in a field-level error is worse than a short default.
 */
function problemDetail(problem: unknown): string {
  if (typeof problem !== 'object' || problem === null) return '';
  const detail = (problem as Record<string, unknown>).detail;
  if (typeof detail !== 'string') return '';
  const trimmed = detail.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : '';
}

export async function login(
  email: string,
  password: string,
): Promise<LoginOutcome> {
  try {
    const data = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (data.mfaSetupRequired) return { kind: 'mfa-setup' };
    if (data.mfaChallengeRequired) return { kind: 'mfa-challenge' };
    return { kind: 'ok' };
  } catch (err) {
    return { kind: 'error', message: authError(err, 'Invalid credentials.') };
  }
}

export type VerifyOutcome = { kind: 'ok' } | { kind: 'error'; message: string };

/**
 * Mirrors `MfaVerifyDto`'s regex: a 6-digit TOTP, or a 10-character
 * backup code from the Crockford-style alphabet (ambiguous 0/1/I/O
 * excluded), optionally split by spaces or dashes.
 *
 * Checked client-side purely so a half-typed code produces an instant,
 * specific message instead of a round-trip that comes back 400. The
 * server remains the authority — this is never the only check.
 */
const MFA_TOKEN_RE = /^\s*(\d{6}|[2-9A-HJ-NP-Z]{5}[\s-]*[2-9A-HJ-NP-Z]{5})\s*$/i;

export async function verifyMfa(token: string): Promise<VerifyOutcome> {
  if (!MFA_TOKEN_RE.test(token)) {
    return {
      kind: 'error',
      message: 'Enter the 6-digit code from your authenticator, or a backup code.',
    };
  }
  try {
    await apiFetch('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    return { kind: 'ok' };
  } catch (err) {
    // A 401 here means the code was wrong — NOT that the session died.
    // Handled locally so the user stays on the challenge screen rather
    // than being bounced to login by the query client's global handler.
    return { kind: 'error', message: authError(err, 'Invalid code.') };
  }
}

/**
 * Whether the current session can reach protected resources.
 *
 * Used by the MFA-setup hand-off to detect that enrolment finished in a
 * desktop tab. It works without a re-login because `mfaSetupRequired`
 * derives from `user.mfaEnforcementCompletedAt` — a *user* column, not a
 * session flag — and `AuthGuard` reloads the user row from the database
 * on every request rather than trusting the access token's claims. So
 * the moment desktop enrolment writes that column, the next request from
 * this device sees it. No token-TTL lag.
 */
export async function sessionUsable(): Promise<boolean> {
  try {
    await apiFetch('/auth/me');
    return true;
  } catch {
    return false;
  }
}

/**
 * End the session server-side.
 *
 * **Never swallow a failure here.** The session cookie is HttpOnly, so
 * the client cannot clear it itself — only this call can. If the request
 * fails and we navigate to the login screen anyway, the user is told
 * they signed out while the session is still live: anyone who reopens
 * `/m/app` on that device is authenticated. On a shared or handed-over
 * phone that is a real exposure, and it is silent by construction.
 *
 * A 401 is the one benign failure — it means the session was already
 * gone, which is the outcome we wanted.
 */
export async function logout(): Promise<{ ok: boolean; message?: string }> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { ok: true };
    return {
      ok: false,
      message:
        err instanceof ApiError
          ? 'Couldn’t sign out. Your session is still active — try again.'
          : 'Couldn’t sign out. Check your connection and try again — your session is still active.',
    };
  }
}
