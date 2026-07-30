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
import { TabShell } from './screens/TabShell';
import { PasswordsListScreen } from './features/passwords/PasswordsListScreen';
import { PasswordDetailScreen } from './features/passwords/PasswordDetailScreen';
import { PasswordFormScreen } from './features/passwords/PasswordFormScreen';
import { ArticlesListScreen } from './features/articles/ArticlesListScreen';
import { ArticleDetailScreen } from './features/articles/ArticleDetailScreen';
import { AssetsListScreen } from './features/assets/AssetsListScreen';
import { AssetDetailScreen } from './features/assets/AssetDetailScreen';
import { AssetFormScreen } from './features/assets/AssetFormScreen';
import { LayoutChooserScreen } from './features/assets/LayoutChooserScreen';
import { LauncherScreen } from './features/launcher/LauncherScreen';
import { ChangePasswordScreen } from './features/profile/ChangePasswordScreen';
import { ProfileScreen } from './features/profile/ProfileScreen';
import { SearchScreen } from './features/search/SearchScreen';
import { signOutAndReset } from './lib/sign-out';
import { UUID_RE } from './lib/uuid';

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
 * `/app` therefore keeps existing — since Phase 5b as the global
 * launcher screen (org-free home). Renaming it would break `start_url`
 * and the prebuild guard that cross-checks it; only the component
 * behind the path may change.
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
  /**
   * `folder` must be a UUID or it is dropped: a tampered/mangled deep
   * link (`?folder=abc`) would otherwise be forwarded to the API, which
   * now 400s malformed folder ids — a dropped param degrades to the
   * unfiltered list instead of an error screen.
   */
  validateSearch: (search: Record<string, unknown>): { folder?: string } => {
    const folder = search.folder;
    return typeof folder === 'string' && UUID_RE.test(folder) ? { folder } : {};
  },
  component: function ArticlesRoute() {
    const filter = articlesRoute.useSearch();
    return <ArticlesListScreen filter={filter} />;
  },
});

const articleDetailRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/articles/$articleId',
  component: function ArticleDetailRoute() {
    const { articleId } = articleDetailRoute.useParams();
    return <ArticleDetailScreen articleId={articleId} />;
  },
});

const assetsRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/assets',
  /**
   * `layout` must be a UUID or it is dropped — the assets list endpoint
   * treats a malformed `layout` as an empty result set, so a mangled
   * deep link degrades to the unfiltered list instead of a blank one.
   */
  validateSearch: (search: Record<string, unknown>): { layout?: string } => {
    const layout = search.layout;
    return typeof layout === 'string' && UUID_RE.test(layout) ? { layout } : {};
  },
  component: function AssetsRoute() {
    const filter = assetsRoute.useSearch();
    return <AssetsListScreen filter={filter} />;
  },
});

// Full-viewport form pages, mirroring the passwords pair: the static
// `/assets/new` outranks `$assetId` in route scoring, and the Shell
// hides the tab bar for both (`hideTabBarFor`). `/assets/new` without
// a `?layout` renders the layout chooser; with one it renders the
// create form — deep-linkable. The chooser REPLACES itself with the
// form (see LayoutChooserScreen) so the create flow holds one stack
// slot above the list, which is what keeps the created detail's
// "‹ Assets" popping to the list rather than back into the chooser.
const assetNewRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/assets/new',
  validateSearch: (search: Record<string, unknown>): { layout?: string } => {
    const layout = search.layout;
    return typeof layout === 'string' && UUID_RE.test(layout) ? { layout } : {};
  },
  component: function AssetNewRoute() {
    const { layout } = assetNewRoute.useSearch();
    return layout ? (
      <AssetFormScreen mode="create" layoutId={layout} />
    ) : (
      <LayoutChooserScreen />
    );
  },
});

const assetDetailRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/assets/$assetId',
  component: function AssetDetailRoute() {
    const { assetId } = assetDetailRoute.useParams();
    return <AssetDetailScreen assetId={assetId} />;
  },
});

const assetEditRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/assets/$assetId/edit',
  component: function AssetEditRoute() {
    const { assetId } = assetEditRoute.useParams();
    return <AssetFormScreen mode="edit" assetId={assetId} />;
  },
});

const moreRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/more',
  component: MoreTab,
});

/**
 * The account surface (Phase 5c). Pushed from More's identity card, and
 * org-free by stamp like `/more` and `/search` are (`isOrgFreeEntry`) so it
 * works for an account with no companies at all — while entering it from
 * inside a client keeps that client in context.
 *
 * The tab bar hides for both paths (`hideTabBarFor`): the account is not a
 * company-scoped destination, and `tabIdForPath` has no tab to light up.
 */
const profileRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/profile',
  component: ProfileScreen,
});

const changePasswordRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/profile/password',
  component: ChangePasswordScreen,
});

// Full-screen search takeover (2b) — the tab bar hides for it
// (`hideTabBarFor`), and the query rides `?q=` so back-from-detail
// restores the exact search. Inside the tab layout so the `?sheet=ask`
// overlay (the Ask handoff card) keeps working from here.
const searchRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/search',
  /**
   * Trimmed and capped at the server's 200-char limit — a longer or
   * blank deep link degrades to the empty search screen rather than a
   * 400 from the API.
   */
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = search.q;
    if (typeof q !== 'string') return {};
    const trimmed = q.trim().slice(0, 200);
    return trimmed ? { q: trimmed } : {};
  },
  component: function SearchRoute() {
    const { q } = searchRoute.useSearch();
    return <SearchScreen query={q ?? ''} />;
  },
});

/**
 * `/m` (and any unmatched path) lands on the launcher — the org-free
 * home at `/m/app` (Phase 5b). Pre-5b both redirected to `/passwords`
 * under a silently-adopted org.
 */
function ToLauncher() {
  return <Navigate to="/app" replace />;
}

const indexRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/',
  component: ToLauncher,
});

const appRoute = createRoute({
  getParentRoute: () => tabsLayoutRoute,
  path: '/app',
  component: LauncherScreen,
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
          // Land on the launcher — "appears on app launch" includes the
          // sign-in path (Phase 5b).
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
    return (
      <MfaChallengeScreen onDone={() => void navigate({ to: '/app' })} />
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
    articleDetailRoute,
    assetsRoute,
    assetNewRoute,
    assetDetailRoute,
    assetEditRoute,
    moreRoute,
    profileRoute,
    changePasswordRoute,
    searchRoute,
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
  defaultNotFoundComponent: ToLauncher,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
