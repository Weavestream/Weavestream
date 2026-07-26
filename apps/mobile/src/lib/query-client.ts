import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, shouldRetry } from './api';
import { redirectToLogin } from './navigate';

/**
 * The global "session is gone" handler.
 *
 * **The redirect keys off the caller, not the status.** An invalid MFA
 * code and a wrong password both return 401 by design
 * (`auth.service.ts` throws `UnauthorizedException('Invalid MFA code')`),
 * so a blanket "any 401 → /m/login" would bounce a technician off the
 * challenge screen mid-flow instead of showing "Invalid code".
 *
 * The discrimination is structural rather than a status allowlist: auth
 * screens call `apiFetch` directly and handle their own failures, and
 * only protected-resource traffic goes through TanStack Query. A new
 * auth endpoint therefore cannot forget to opt out — it opts out by not
 * being a query.
 */
function handle(error: unknown) {
  if (error instanceof ApiError && error.status === 401) redirectToLogin();
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    // BOTH caches. TanStack Query dispatches query errors and mutation
    // errors through separate paths; wiring only `QueryCache` would
    // leave a failed mutation on a dead session silently stuck with a
    // spinner and no redirect.
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        // Field technicians move between screens constantly; refetching
        // on every focus would hammer a flaky radio.
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
      mutations: { retry: false },
    },
  });
}
