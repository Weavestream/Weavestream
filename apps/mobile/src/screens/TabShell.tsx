import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation } from '@tanstack/react-router';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
import { ApiError, apiFetch } from '../lib/api';
import { OrgProvider, useOrgScope, type Org } from '../lib/org-scope';
import { useScopedNavigate, useStaleScopeGuard } from '../lib/scoped-nav';
import { recoveryRouteFor } from '../lib/session-recovery';
import {
  TAB_ROOTS,
  hideTabBarFor,
  rememberLocation,
  rememberedLocation,
  tabIdForPath,
  type TabId,
} from '../lib/tab-stacks';
import { AppLogo } from '../components/AppLogo';
import { AskSheet } from '../components/AskSheet';
import { OrgSheet } from '../components/OrgSheet';
import { StepUpHost } from '../components/StepUpHost';
import { TabBar } from '../components/TabBar';
import { ToastProvider } from '../components/Toast';
import { Button, Subtitle, Title } from '../components/primitives';
import { SkeletonList } from '../components/states';

/**
 * The persistent tab shell.
 *
 * A layout route rather than a per-screen wrapper, so the tab bar mounts
 * once and survives tab switches — remounting it would reset the org
 * sheet, the toast queue, and any in-flight step-up prompt on every tab
 * change.
 */

/**
 * The slice of `/auth/me` this app consumes. Note the memberships are
 * the **flat** `{ companyId }` shape — the web `/me` endpoint nests
 * `company: { id, name, slug }` instead. The shared access helpers
 * (`effectiveCompanyAccess` et al.) accept either, and `Me` satisfies
 * their structural `ViewerLike`, which is what `useCompanyAccess`
 * relies on to gate write UI.
 */
export interface MeMembership {
  companyId: string;
  role: MembershipRole;
  expiresAt: string | null;
}

export interface Me {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  globalAccess: GlobalAccess | null;
  platformCapabilities: PlatformCapability[];
  memberships: MeMembership[];
}

const MeContext = createContext<Me | null>(null);
export function useMe(): Me | null {
  return useContext(MeContext);
}

const OpenOrgSheetContext = createContext<() => void>(() => {});
/** Lets a screen's header open the switcher without threading a prop. */
export function useOpenOrgSheet(): () => void {
  return useContext(OpenOrgSheetContext);
}

/** Pre-shell screen: no tab bar yet, because there is no session yet. */
function BareScreen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col px-4 pb-edge-b pt-safe-t">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 py-10">
        <div className="flex justify-center">
          <AppLogo height={24} />
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * One `me` query for all four tabs — one skeleton, one redirect path.
 *
 * The error doctrine here is Phase 0's, unchanged, and deliberately not
 * "any error → login": the query client already redirects on 401, and
 * only on 401, because that is the one status meaning the session is
 * genuinely gone. A blanket redirect would send a technician on a flaky
 * radio to a login screen that tells them nothing and then appears to
 * "work", hiding the real fault.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/auth/me'),
  });

  if (isPending) {
    return (
      <BareScreen>
        <SkeletonList rows={4} />
      </BareScreen>
    );
  }

  if (isError) {
    // A 403 from a partially authenticated session is recoverable, not
    // terminal — without this, launching the installed PWA straight to
    // /m/app with unfinished MFA dead-ends on a Retry that can never work.
    const recovery = recoveryRouteFor(error);
    if (recovery) return <Navigate to={recovery} replace />;

    const denied = error instanceof ApiError && error.status === 403;
    return (
      <BareScreen>
        <Title>Weavestream</Title>
        <Subtitle>
          {denied
            ? 'You don’t have access to this.'
            : 'Couldn’t reach Weavestream. Check your connection.'}
        </Subtitle>
        {!denied && <Button onClick={() => void refetch()}>Try again</Button>}
      </BareScreen>
    );
  }

  return <MeContext.Provider value={data ?? null}>{children}</MeContext.Provider>;
}

/** `?sheet=…` presents overlays, so back closes them via the router. */
interface ShellSearch {
  sheet?: 'org' | 'ask';
}

function Shell() {
  const location = useLocation();
  const navigate = useScopedNavigate();
  const { switchOrg } = useOrgScope();
  useStaleScopeGuard();

  const pathname = location.pathname;
  const activeTab = tabIdForPath(pathname);

  // The sheet param rides alongside whatever search the current screen
  // owns (the passwords list's filter chips live in `?folder=`/`?view=`).
  // Opening and closing the sheet must carry those keys along, or a
  // filtered list loses its filter the moment the org sheet closes.
  const rawSearch = (location.search ?? {}) as Record<string, unknown>;
  const sheet = rawSearch.sheet as ShellSearch['sheet'];
  // Memoized on the location's (structurally stable) search object so
  // the remember-effect below keys off real changes, not new object
  // identities per render.
  const searchSansSheet = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(rawSearch).filter(([key]) => key !== 'sheet'),
      ),
    [rawSearch],
  );

  // Remember where each tab is — WITH its screen-owned search params
  // (minus the sheet overlay), so returning to a filtered list restores
  // the filter instead of silently unfiltering it.
  useEffect(() => {
    rememberLocation(pathname, searchSansSheet);
  }, [pathname, searchSansSheet]);

  function onSelectTab(tab: TabId) {
    // Second tap on the active tab pops to its root; `replace` so
    // repeatedly tapping it doesn't grow history.
    if (tab === activeTab) {
      navigate({ to: TAB_ROOTS[tab], replace: true });
      return;
    }
    const loc = rememberedLocation(tab);
    navigate({ to: loc.path, search: loc.search });
  }

  // Opening **pushes**: that is what makes the back button close the sheet
  // instead of leaving the screen. Closing **replaces**, which consumes the
  // pushed entry so back doesn't immediately re-open it.
  const showSheet = (which: NonNullable<ShellSearch['sheet']>) =>
    navigate({ to: pathname, search: { ...searchSansSheet, sheet: which } });
  const closeSheet = () =>
    navigate({ to: pathname, replace: true, search: searchSansSheet });

  /**
   * Switching org is one coordinated step, owned here because it is the
   * only place that knows both the scope and the current tab.
   *
   * The `orgId` is passed **explicitly from `org.id`**: `switchOrg` has
   * just updated the scope, but this closure still holds the previous
   * org, so a stamp taken from context would mark the very first
   * post-switch entry stale and the guard would bounce the user straight
   * back out.
   *
   * `replace` consumes the `?sheet=org` entry, and landing on the tab root
   * matches the handoff — selecting an org resets the visible stack.
   */
  function onSelectOrg(org: Org) {
    switchOrg(org);
    navigate({
      to: TAB_ROOTS[activeTab ?? 'passwords'],
      replace: true,
      orgId: org.id,
    });
  }

  return (
    <OpenOrgSheetContext.Provider value={() => showSheet('org')}>
      {/* `h-dvh`, not `h-screen`: on iOS Safari `vh` includes the area
          behind the toolbar, which would push the tab bar off-screen.
          `min-h-0` on the content is what lets it scroll inside the
          column instead of sizing to its content. */}
      <div className="flex h-dvh flex-col overflow-hidden bg-bg">
        <Outlet />

        {/* Create/edit forms own the whole viewport — see hideTabBarFor. */}
        {!hideTabBarFor(pathname) && (
          <TabBar
            activeTab={activeTab}
            onSelectTab={onSelectTab}
            // Ask is presented over the current tab, not routed to.
            onAsk={() => showSheet('ask')}
          />
        )}

        <OrgSheet
          open={sheet === 'org'}
          onClose={closeSheet}
          onSelect={onSelectOrg}
        />
        <AskSheet open={sheet === 'ask'} onClose={closeSheet} />
        <StepUpHost />
      </div>
    </OpenOrgSheetContext.Provider>
  );
}

export function TabShell() {
  return (
    <RequireSession>
      <OrgProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </OrgProvider>
    </RequireSession>
  );
}
