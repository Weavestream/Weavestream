/**
 * Redact a URL for durable storage in audit logs / error records.
 *
 * Preserves scheme, host, port, and path — enough to investigate a blocked
 * or failed request — and removes every channel that can carry a secret:
 *   - userinfo (`user:pass@`)
 *   - the entire query string (API keys, signed-URL tokens, webhook creds)
 *   - the fragment (`#…`, e.g. OAuth implicit-flow tokens)
 *
 * On an unparseable URL we cannot trust any substring to be free of userinfo
 * (`https://user:pass@%zz/path` fails to parse with the credential still in
 * the authority) or query secrets, so we return a fixed marker rather than
 * echo any part of the input. This keeps the "never store userinfo or query
 * secrets" guarantee absolute even for malformed input.
 *
 * For valid URLs the return value is `URL.toString()`, which canonicalizes
 * (trailing slash on a bare authority, default-port removal, host
 * lower-casing). That normalization is intentional and never adds or removes
 * a secret-bearing component.
 */
export const UNPARSABLE_URL = '[redacted-unparsable-url]';

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return UNPARSABLE_URL;
  }
}
