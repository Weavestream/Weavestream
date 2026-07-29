/**
 * @jest-environment jsdom
 */
/**
 * The Phase 5b launcher↔global-search↔detail HISTORY sequence, proven
 * against a real router + real history — not navigation-callback mocks
 * (plan-review P2-7): launcher → search (push, upIsBack) → cross-org
 * hit (switch + stamped push) → "‹ Search" POPS to still-global search
 * (org-free exemption, arrival-clear) → Done POPS to the launcher, with
 * no duplicate launcher entry left behind.
 *
 * Screens are stubs; the machinery is real: `useStaleScopeGuard`,
 * `OrgProvider` (org-free boot), `useScopedNavigate`, `useEnterOrg`,
 * `useBackOr`/`useBackLabel`, and the org stamps in history state.
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useCanGoBack,
  useLocation,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readOrgStamp } from '../../lib/org-free';
import { OrgProvider, useOrgScope, type Org } from '../../lib/org-scope';
import { useScopedNavigate, useStaleScopeGuard } from '../../lib/scoped-nav';
import { useBackLabel, useBackOr } from '../../lib/use-back';
import { useEnterOrg } from '../../lib/use-enter-org';

jest.mock('../../lib/api', () => ({
  apiFetch: jest.fn(() => Promise.reject(new Error('no network in this test'))),
  ApiError: class extends Error {},
}));

const ORG_X: Org = { id: 'org-x', name: 'Northwind MSP', initials: 'NM', subtitle: null };

function LauncherStub() {
  const navigate = useScopedNavigate();
  const canGoBack = useCanGoBack();
  const { currentOrg } = useOrgScope();
  return (
    <div data-testid="launcher" data-cangoback={canGoBack} data-org={currentOrg?.id ?? 'none'}>
      <button onClick={() => navigate({ to: '/search', upIsBack: true })}>go-search</button>
    </div>
  );
}

function SearchStub() {
  const location = useLocation();
  const globalMode = readOrgStamp(location.state) === null;
  const enterOrg = useEnterOrg();
  const done = useBackOr(globalMode ? '/app' : '/passwords');
  return (
    <div data-testid="search" data-global={globalMode}>
      <button
        onClick={() =>
          enterOrg(ORG_X, {
            to: '/passwords/p1',
            history: 'push',
            upIsBack: true,
            backLabel: 'Search',
          })
        }
      >
        open-hit
      </button>
      <button onClick={done}>done</button>
    </div>
  );
}

function DetailStub() {
  const back = useBackOr('/passwords');
  const label = useBackLabel('Passwords');
  const { currentOrg } = useOrgScope();
  return (
    <div data-testid="detail" data-org={currentOrg?.id ?? 'none'}>
      <button onClick={back}>{label}</button>
    </div>
  );
}

function buildApp() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const layout = createRoute({
    getParentRoute: () => rootRoute,
    id: 'layout',
    component: function Layout() {
      useStaleScopeGuard();
      return <Outlet />;
    },
  });
  const screens = [
    { path: '/app', component: LauncherStub },
    { path: '/search', component: SearchStub },
    { path: '/passwords/$id', component: DetailStub },
    { path: '/passwords', component: () => <div data-testid="passwords-root" /> },
  ].map(({ path, component }) =>
    createRoute({ getParentRoute: () => layout, path, component }),
  );
  return createRouter({
    routeTree: rootRoute.addChildren([layout.addChildren(screens)]),
    history: createMemoryHistory({ initialEntries: ['/app'] }),
  });
}

it('launcher → global search → cross-org hit → pop to global search → Done pops home', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = buildApp();
  render(
    <QueryClientProvider client={client}>
      <OrgProvider bootOrgFree>
        <RouterProvider router={router} />
      </OrgProvider>
    </QueryClientProvider>,
  );

  // Boot: org-free launcher, nothing behind it.
  await waitFor(() => expect(screen.getByTestId('launcher')).toBeInTheDocument());
  expect(screen.getByTestId('launcher')).toHaveAttribute('data-cangoback', 'false');
  expect(screen.getByTestId('launcher')).toHaveAttribute('data-org', 'none');

  // Launcher → search: a PUSH stamped org-free.
  fireEvent.click(screen.getByText('go-search'));
  await waitFor(() => expect(screen.getByTestId('search')).toBeInTheDocument());
  expect(screen.getByTestId('search')).toHaveAttribute('data-global', 'true');

  // Cross-org hit: switch + stamped push; the detail renders inside the
  // hit's org and its chevron tells the truth about where it pops.
  fireEvent.click(screen.getByText('open-hit'));
  await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
  expect(screen.getByTestId('detail')).toHaveAttribute('data-org', ORG_X.id);
  expect(screen.getByText('Search')).toBeInTheDocument();

  // "‹ Search" POPS back to the SAME global search entry — the org-free
  // exemption must not bounce it despite the now-selected org, and the
  // arrival-clear leaves org context.
  fireEvent.click(screen.getByText('Search'));
  await waitFor(() => expect(screen.getByTestId('search')).toBeInTheDocument());
  expect(screen.getByTestId('search')).toHaveAttribute('data-global', 'true');

  // Done POPS to the launcher. `canGoBack` false = index 0 = the boot
  // entry — a replace-based Done would have left a duplicate launcher
  // entry here and this attribute would read true.
  fireEvent.click(screen.getByText('done'));
  await waitFor(() => expect(screen.getByTestId('launcher')).toBeInTheDocument());
  expect(screen.getByTestId('launcher')).toHaveAttribute('data-cangoback', 'false');
  await waitFor(() =>
    expect(screen.getByTestId('launcher')).toHaveAttribute('data-org', 'none'),
  );
});
