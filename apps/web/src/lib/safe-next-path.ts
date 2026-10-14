/**
 * Where a page may send the user after login and MFA. Only the remote MCP
 * consent page needs a return path, so only it is allowed: an exact,
 * same-origin path with an interaction id. Anything else — absolute URLs,
 * `//host`, backslashes, `..`, query strings — is ignored, so `?next=` can
 * never become an open redirect.
 */
export const CONSENT_UID = /^[A-Za-z0-9_-]{16,64}$/;

const CONSENT_PATH = /^\/oauth\/consent\/([A-Za-z0-9_-]{16,64})$/;

export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return CONSENT_PATH.test(raw) ? raw : null;
}

/** `?next=…` for a validated path, or nothing. */
export function nextQuery(next: string | null | undefined): string {
  const safe = safeNextPath(next);
  return safe ? `?next=${encodeURIComponent(safe)}` : '';
}
