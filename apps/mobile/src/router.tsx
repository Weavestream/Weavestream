import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
} from '@tanstack/react-router';
import { AppShell } from './screens/AppShell';
import { LoginScreen } from './screens/LoginScreen';
import { MfaChallengeScreen } from './screens/MfaChallengeScreen';
import { MfaSetupHandoffScreen } from './screens/MfaSetupHandoffScreen';
import { logout } from './lib/auth';

/**
 * Routes are mounted under `basepath: '/m'`, so `/app` here is `/m/app`
 * in the address bar.
 *
 * `/m/app` rather than `/m` as the landing route is not arbitrary: the
 * manifest scopes to `/m/` (so it does not bleed into `/me` and
 * `/mfa/*`), and `start_url` must sit inside scope while carrying no
 * trailing slash, or Next's normalization redirects it back out. Bare
 * `/m` is handled by a 308 in the route handler. See
 * apps/mobile/MANIFEST-NOTES.md — the scope, the start URL, and that
 * redirect are one decision.
 */

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AppShell,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  component: AppShell,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: function LoginRoute() {
    const navigate = useNavigate();
    return (
      <LoginScreen
        onDone={(next) => {
          if (next === 'app') void navigate({ to: '/app' });
          else if (next === 'mfa-challenge')
            void navigate({ to: '/mfa/challenge' });
          else void navigate({ to: '/mfa/setup' });
        }}
      />
    );
  },
});

const mfaChallengeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa/challenge',
  component: function MfaChallengeRoute() {
    const navigate = useNavigate();
    return <MfaChallengeScreen onDone={() => void navigate({ to: '/app' })} />;
  },
});

const mfaSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa/setup',
  component: function MfaSetupRoute() {
    const navigate = useNavigate();
    return (
      <MfaSetupHandoffScreen
        onReady={() => void navigate({ to: '/app' })}
        // Returns the failure rather than navigating on it: pretending
        // to sign out while the HttpOnly session is still live is the
        // one outcome worse than showing an error.
        onSignOut={async () => {
          const result = await logout();
          if (result.ok) void navigate({ to: '/login' });
          return result;
        }}
      />
    );
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  appRoute,
  loginRoute,
  mfaChallengeRoute,
  mfaSetupRoute,
]);

export const router = createRouter({
  routeTree,
  basepath: '/m',
  // Any unmatched path under /m falls back to the shell rather than a
  // dead end — the route handler already serves the same HTML for
  // arbitrary deep links, so the client must agree.
  defaultNotFoundComponent: AppShell,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
