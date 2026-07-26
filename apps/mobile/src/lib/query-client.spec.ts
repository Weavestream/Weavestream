/**
 * The other half of the 401 discrimination.
 *
 * `auth.spec.ts` asserts that auth-flow 401s (wrong password, wrong MFA
 * code) stay on their screen. These assert the complement: a 401 from
 * *protected* traffic does route to login — and that it does so through
 * BOTH of TanStack Query's error paths.
 *
 * The mutation case is the one that is easy to get wrong. Query
 * dispatches query errors and mutation errors through separate caches,
 * so wiring only `QueryCache` leaves a failed mutation on a dead session
 * stuck with a spinner and no redirect.
 */
import { createQueryClient } from './query-client';
import { ApiError } from './api';
import { redirectToLogin } from './navigate';

jest.mock('./navigate', () => ({
  LOGIN_PATH: '/m/login',
  redirectToLogin: jest.fn(),
}));

const redirect = redirectToLogin as jest.MockedFunction<typeof redirectToLogin>;

beforeEach(() => redirect.mockClear());

/** Drive a query to failure without letting the rejection escape. */
async function failingQuery(client: ReturnType<typeof createQueryClient>, error: unknown) {
  await client
    .fetchQuery({
      queryKey: [Math.random().toString(36)],
      queryFn: () => Promise.reject(error),
      retry: false,
    })
    .catch(() => undefined);
}

describe('global 401 handling', () => {
  it('redirects when a protected QUERY 401s', async () => {
    await failingQuery(createQueryClient(), new ApiError(401, null));
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('redirects when a protected MUTATION 401s', async () => {
    const client = createQueryClient();
    await client
      .getMutationCache()
      .build(client, {
        mutationFn: () => Promise.reject(new ApiError(401, null)),
        retry: false,
      })
      .execute(undefined)
      .catch(() => undefined);

    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('leaves a 500 alone — that is a retryable outage, not a dead session', async () => {
    await failingQuery(createQueryClient(), new ApiError(500, null));
    expect(redirect).not.toHaveBeenCalled();
  });

  it('leaves a 403 alone — step-up and RBAC denials are not session loss', async () => {
    await failingQuery(createQueryClient(), new ApiError(403, null));
    expect(redirect).not.toHaveBeenCalled();
  });

  it('leaves a transport failure alone', async () => {
    await failingQuery(createQueryClient(), new TypeError('Failed to fetch'));
    expect(redirect).not.toHaveBeenCalled();
  });
});
