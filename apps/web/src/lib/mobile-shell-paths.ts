/**
 * Path classification for the `/m` catch-all.
 *
 * Kept out of the route handler so it is unit-testable — the handler
 * imports `next/server` types and reads from disk at module scope.
 */

/**
 * True when a path is asking for a static resource rather than a client
 * route: anything whose final segment carries a file extension.
 *
 * Real files under `public/m/` are served by Next's filesystem check
 * *before* dynamic routes, so if such a request reaches the catch-all
 * the file does not exist — and the answer must be 404, never the shell.
 *
 * Returning the shell here was a real bug, not a cosmetic one. A request
 * for a deleted `/m/assets/index-<oldhash>.js` handed the browser HTML
 * under a JavaScript URL; paired with an `immutable` cache header keyed
 * on pathname, the browser would keep that for a year and parse HTML as
 * a script on every subsequent load. Permanent, per-browser, and no
 * redeploy could clear it.
 *
 * Client routes never carry extensions (`/m/app`, `/m/passwords/abc`),
 * so this costs nothing and additionally stops `/m/index.html` and
 * `/m/shell.html` from aliasing the shell.
 */
export function looksLikeStaticAsset(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  return last.includes('.');
}
