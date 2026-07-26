/**
 * Sign-out must leave nothing of the previous session behind.
 *
 * The failure this guards is concrete: user A signs out, user B signs in
 * on the same device, and B lands in A's client looking at A's data
 * because the org key survived in `localStorage` and the query cache was
 * never dropped. Both halves — clearing the key and hard-navigating —
 * have to happen, and neither may happen when the sign-out request failed.
 */
import { signOutAndReset } from './sign-out';
import { logout } from './auth';
import { redirectToLogin } from './navigate';
import { clearPersistedOrg } from './org-scope';

jest.mock('./auth', () => ({ logout: jest.fn() }));
jest.mock('./navigate', () => ({ redirectToLogin: jest.fn() }));
jest.mock('./org-scope', () => ({ clearPersistedOrg: jest.fn() }));

const mockLogout = logout as jest.MockedFunction<typeof logout>;
const mockRedirect = redirectToLogin as jest.MockedFunction<
  typeof redirectToLogin
>;
const mockClearOrg = clearPersistedOrg as jest.MockedFunction<
  typeof clearPersistedOrg
>;

beforeEach(() => jest.clearAllMocks());

describe('signOutAndReset', () => {
  it('clears the persisted org and hard-navigates on success', async () => {
    mockLogout.mockResolvedValue({ ok: true });

    await expect(signOutAndReset()).resolves.toEqual({ ok: true });

    expect(mockClearOrg).toHaveBeenCalledTimes(1);
    // A hard navigation, not a client route change: every cached query
    // belongs to a session that no longer exists.
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear or navigate when sign-out failed', async () => {
    // The session cookie is HttpOnly, so only the server can end the
    // session. Navigating anyway would tell the user they signed out while
    // the session is still live — on a shared phone, a real exposure.
    mockLogout.mockResolvedValue({
      ok: false,
      message: 'Couldn’t sign out. Your session is still active — try again.',
    });

    const result = await signOutAndReset();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/still active/i);
    expect(mockClearOrg).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('treats an already-dead session as success and still resets', async () => {
    // `logout()` maps a 401 to ok:true — the session was already gone,
    // which is the outcome we wanted. The client-side reset must still run.
    mockLogout.mockResolvedValue({ ok: true });

    await signOutAndReset();

    expect(mockClearOrg).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  it('clears the org key before navigating', async () => {
    // Ordering matters: the hard navigation may begin unloading the page,
    // and a `localStorage` write racing that is not guaranteed to land.
    const order: string[] = [];
    mockLogout.mockResolvedValue({ ok: true });
    mockClearOrg.mockImplementation(() => void order.push('clear'));
    mockRedirect.mockImplementation(() => void order.push('redirect'));

    await signOutAndReset();

    expect(order).toEqual(['clear', 'redirect']);
  });
});
