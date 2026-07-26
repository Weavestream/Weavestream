import { logout } from './auth';
import { redirectToLogin } from './navigate';
import { clearPersistedOrg } from './org-scope';

/**
 * Sign out and reset every trace of the session on this device.
 *
 * `logout()` alone is not enough. Ending the session server-side leaves
 * the client holding the previous user's `['me']`, their company lists,
 * and their selected org — and the query cache serves those for up to
 * `staleTime` (30s). On a shared or handed-over phone the next person to
 * sign in would land in the previous technician's client, looking at
 * their data, which is the exact failure this reset exists to prevent.
 *
 * Two steps, in this order:
 *
 *  1. Clear the persisted org. A hard reload drops the in-memory query
 *     cache on its own, but `localStorage` survives it, so this has to be
 *     explicit.
 *  2. **Hard-navigate**, not a client route change. `navigate.ts` already
 *     argues this for session loss — every cached query belongs to a
 *     session that no longer exists, and reloading is the cheapest way to
 *     guarantee none of it survives. A voluntary sign-out is the same
 *     situation, reached deliberately.
 *
 * On failure: nothing is cleared and nothing navigates. The session
 * cookie is HttpOnly, so only the server can end the session — telling
 * the user they signed out while it is still live is worse than showing
 * an error. `logout()` already treats a 401 as success (the session was
 * already gone, which is the outcome we wanted).
 */
export async function signOutAndReset(): Promise<{
  ok: boolean;
  message?: string;
}> {
  const result = await logout();
  if (!result.ok) return result;

  clearPersistedOrg();
  redirectToLogin();
  return { ok: true };
}
