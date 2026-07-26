import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { ApiError, apiFetch } from '../lib/api';
import { recoveryRouteFor } from '../lib/session-recovery';
import { Button, Screen, Subtitle, Title } from '../components/ui';

interface Me {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * The Phase 0 shell — intentionally almost empty.
 *
 * Phase 0's exit criterion is that the bundle boots at `/m`,
 * authenticates, and survives past the access-token TTL; not that it
 * shows anything. The tab bar, org switcher, and the three content areas
 * are Phase 1/2.
 *
 * What it does do is exercise the two things Phase 0 exists to prove:
 * a protected read through the same-origin `/api` proxy, and the global
 * 401 → login path when the session is genuinely gone.
 */
export function AppShell() {
  // Goes through TanStack Query on purpose. A 401 here means the session
  // is gone — `AuthGuard.silentRefresh` has already had its chance to
  // rotate the cookie server-side — so the cache's global handler routes
  // to login. Auth-flow calls deliberately bypass Query so a wrong
  // password does not take the same path.
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/auth/me'),
  });

  if (isPending) {
    return (
      <Screen>
        <Title>Weavestream</Title>
        <Subtitle>Loading…</Subtitle>
      </Screen>
    );
  }

  // Deliberately NOT "any error → go to login". The query client already
  // redirects on 401, and only on 401, because that is the one status
  // meaning the session is genuinely gone. A blanket redirect here would
  // defeat that: a flaky radio, a 5xx that exhausted its retries, or an
  // RBAC denial would all bounce the technician to a login screen that
  // tells them nothing and, on re-entering credentials, would appear to
  // "work" while the real fault went undiagnosed.
  //
  // A 403 from a *partially authenticated* session is the exception, and
  // it is recoverable rather than terminal — see `recoveryRouteFor`.
  // Without it, launching the installed PWA straight to `/m/app` with an
  // unfinished MFA session dead-ends on a Retry button that can never
  // succeed.
  if (isError) {
    const recovery = recoveryRouteFor(error);
    if (recovery) return <Navigate to={recovery} replace />;

    const isDenied = error instanceof ApiError && error.status === 403;
    return (
      <Screen>
        <Title>Weavestream</Title>
        <Subtitle>
          {isDenied
            ? 'You don’t have access to this.'
            : 'Couldn’t reach Weavestream. Check your connection.'}
        </Subtitle>
        {!isDenied && <Button onClick={() => void refetch()}>Try again</Button>}
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Weavestream</Title>
      <Subtitle>Signed in as {data?.name || data?.email}</Subtitle>

      <section className="rounded-card border border-line bg-surface p-4">
        <h2 className="text-card-title font-semibold text-text">
          Phase 0 shell
        </h2>
        <ul className="mt-3 space-y-2 font-mono text-meta text-muted">
          <li>accent follows your desktop preference</li>
          <li>geist sans + mono, self-hosted</li>
          <li>session survives the access-token TTL</li>
        </ul>

        <div className="mt-4 flex items-center gap-3">
          <span className="inline-flex h-tap items-center rounded-pill bg-accent px-4 text-body font-semibold text-accent-ink">
            Accent
          </span>
          <span className="inline-flex h-tap items-center rounded-field bg-accent-soft px-4 text-body text-text">
            Soft
          </span>
        </div>
      </section>

      <a
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 flex h-control items-center justify-center rounded-card border border-line bg-surface text-body text-muted"
      >
        Use desktop version
      </a>
    </Screen>
  );
}
