import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useNavigate,
} from '@tanstack/react-router';
import { LoginScreen } from './screens/LoginScreen';
import { MfaChallengeScreen } from './screens/MfaChallengeScreen';
import { MfaSetupHandoffScreen } from './screens/MfaSetupHandoffScreen';
import { MoreTab } from './screens/MoreTab';
import { PlaceholderTab } from './screens/PlaceholderTab';
import { TabShell } from './screens/TabShell';
import { PasswordsListScreen } from './features/passwords/PasswordsListScreen';
import { PasswordDetailScreen } from './features/passwords/PasswordDetailScreen';
import { PasswordFormScreen } from './features/passwords/PasswordFormScreen';
import { signOutAndReset } from './lib/sign-out';

/**
 * Routes are mounted under `basepath: '/m'`, so `/passwords` here is
 * `/m/passwords` in the address bar.
 *
 * `/m/app` rather than `/m` as the landing route is not arbitrary: the
 * manifest scopes to `/m/` (so it does not bleed into `/me` and
 * `/mfa/*`), and `start_url` must sit inside scope while carrying no
 * trailing slash, or Next's normalization redirects it back out. Bare
 * `/m` is handled by a 308 in the route handler. See
 * apps/mobile/MANIFEST-NOTES.md — the scope, the start URL, and that
 * redirect are one decision.
 *
 * `/app` therefore keeps existing, as a redirect into the Passwords tab.
 * Renaming it would break `start_url` and the prebuild guard that
 * cross-checks it.
 */

const rootRoute = createRootRoute({ component: () => <Outlet /> });

/**
 * Pathless layout route (`id`, not `path`) holding the tab shell.
 *
 * The tab bar, org sheet, toast queue and step-up host all live here, so
 * they mount **once** and survive tab switches. Making each tab render
 * its own chrome instead would reset an in-flight step-up prompt every
 * time someone changed tab.
 */
const tabsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'tabs',
  component: TabShell,
  /**
   * Overlays are router state (`?sheet=org`) rather than component state,
   * so the back button closes them instead of leaving the screen. Declared
   * here because search params have to be validated to survive a
   * navigation — an undeclared one gets dropped.
   */
  validateSearch: (search: Record<string, unknown>): { sheet?: 'org' | 'ask' } => {
    const sheet = search.sheet;
    return sheet === 'org' || sheet === 'ask' ? { sheet } : {};
  },
});

const passwordsRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/passwords',
  /**
   * Chip filters ride the search params so back-from-detail restores
   * the filtered view. Undeclared params are dropped on navigation —
   * same reason the layout route declares `sheet`.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { folder?: string; view?: 'attention' | 'archived' } => {
    const out: { folder?: string; view?: 'attention' | 'archived' } = {};
    if (typeof search.folder === 'string' && search.folder) out.folder = search.folder;
    if (search.view === 'attention' || search.view === 'archived') out.view = search.view;
    return out;
  },
  component: function PasswordsRoute() {
    const filter = passwordsRoute.useSearch();
    return <PasswordsListScreen filter={filter} />;
  },
});

const passwordDetailRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/passwords/$passwordId',
  component: function PasswordDetailRoute() {
    const { passwordId } = passwordDetailRoute.useParams();
    return <PasswordDetailScreen passwordId={passwordId} />;
  },
});

// Full-viewport form pages. The static `/passwords/new` outranks the
// `$passwordId` param in TanStack's route scoring, so there is no
// ambiguity with the detail route. The Shell hides the tab bar for
// both paths (`hideTabBarFor`), which is what makes them ordinary
// routed pages rather than overlays.
const passwordNewRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/passwords/new',
  component: function PasswordNewRoute() {
    return <PasswordFormScreen mode="create" />;
  },
});

const passwordEditRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/passwords/$passwordId/edit',
  component: function PasswordEditRoute() {
    const { passwordId } = passwordEditRoute.useParams();
    return <PasswordFormScreen mode="edit" passwordId={passwordId} />;
  },
});

const articlesRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/articles',
  component: function ArticlesRoute() {
    return (
      <PlaceholderTab
        title="Articles"
        note="Runbooks and documentation arrive in the next release."
      />
    );
  },
});

const assetsRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/assets',
  component: function AssetsRoute() {
    return (
      <PlaceholderTab
        title="Assets"
        note="Devices and their layouts arrive in the next release."
      />
    );
  },
});

const moreRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/more',
  component: MoreTab,
});

/** `/m` and `/m/app` both land on the first tab. */
function ToPasswords() {
  return <Navigate to="/passwords" replace />;
}

const indexRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/',
  component: ToPasswords,
});

const appRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/app',
  component: ToPasswords,
});

// ───────────────────────────────────────────────────────────────────
// Auth routes — outside the tab layout: no tab bar, no org scope.
// ───────────────────────────────────────────────────────────────────

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: function LoginRoute() {
    const navigate = useNavigate();
    return (
      <LoginScreen
        onDone={(next) => {
          if (next === 'app') void navigate({ to: '/passwords' });
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
    return (
      <MfaChallengeScreen onDone={() => void navigate({ to: '/passwords' })} />
    );
  },
});

const mfaSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa/setup',
  component: function MfaSetupRoute() {
    return (
      <MfaSetupHandoffScreen
        onReady={() => {
          // Hard-navigate rather than a client route change: enrolment
          // completed in another tab, so this client's `me` and scope
          // queries were resolved against a session that could not reach
          // protected routes. A reload is the cheapest way to start clean.
          window.location.assign('/m/app');
        }}
        // Returns the failure rather than navigating on it: pretending to
        // sign out while the HttpOnly session is still live is the one
        // outcome worse than showing an error. `signOutAndReset` also
        // clears the persisted org and hard-navigates on success.
        onSignOut={signOutAndReset}
      />
    );
  },
});

const routeTree = rootRoute.addChildren([
  tabsLayoutRoute.addChildren([
    indexRoute,
    appRoute,
    passwordsRoute,
    passwordNewRoute,
    passwordDetailRoute,
    passwordEditRoute,
    articlesRoute,
    assetsRoute,
    moreRoute,
  ]),
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
  defaultNotFoundComponent: ToPasswords,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
