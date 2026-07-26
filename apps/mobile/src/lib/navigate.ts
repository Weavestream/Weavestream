export const LOGIN_PATH = '/m/login';

/**
 * Hard-navigate to the login screen after the session is lost.
 *
 * A full page load rather than a client-side route change: every cached
 * query belongs to a session that no longer exists, and reloading is the
 * cheapest way to guarantee none of it survives into the next one.
 *
 * Isolated in its own module so `query-client.ts` has a seam a test can
 * mock. `window.location` is non-configurable under jsdom, so the
 * alternative would be untestable — and the 401 routing is exactly the
 * behaviour that most needs a test.
 */
export function redirectToLogin(): void {
  if (window.location.pathname !== LOGIN_PATH) {
    window.location.assign(LOGIN_PATH);
  }
}
