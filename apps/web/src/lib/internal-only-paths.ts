/**
 * API paths that are internal-only: the web container polls them
 * server-side, but no browser request may reach them through the
 * `/api/*` (or `/health/*`) reverse proxy. The proxy 404s these before
 * forwarding, so an internet user can't ride the blind proxy to an
 * endpoint the API only guards by socket peer-trust. (WS-028)
 *
 * The match is EXACT — deliberately not a prefix — so the admin
 * `/api/v1/ip-rules` CRUD surface (managed through the same proxy) is
 * untouched; only `/api/v1/ip-rules/active` is denied.
 */
export const INTERNAL_ONLY_API_PATHS: readonly string[] = [
  '/api/v1/ip-rules/active',
  '/api/v1/ip-rules/blocked-report',
];

/**
 * True if the fully-constructed upstream URL targets an internal-only
 * path. Matches on the URL's normalized pathname so obfuscation can't
 * slip past:
 *   - `new URL()` collapses `.`/`..` (and their `%2e` encodings) exactly
 *     the way undici will when it actually sends the request, so we match
 *     what the API will really see — including `/health/../api/...`
 *     traversal from the health catch-all.
 *   - lowercased because Express routing is case-insensitive.
 *   - duplicate slashes collapsed and a trailing slash stripped because
 *     Express treats those as the same route.
 * An unparseable URL is treated as internal-only (deny-safe): better to
 * 404 a malformed internal target than risk forwarding it.
 */
export function isInternalOnlyUpstreamUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  const normalized = pathname
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  return INTERNAL_ONLY_API_PATHS.includes(normalized);
}
