/**
 * @jest-environment jsdom
 */
/**
 * Org stamping and the stale-scope guard, driven through a real router.
 *
 * The failure being prevented is specific and silent: switch org, press
 * back, and land on the *previous* client's detail screen under the *new*
 * client's header. The stamp plus the guard is what makes that impossible,
 * and the two conditions most likely to be got wrong are covered here —
 * the guard must not fire before scope has resolved, and it must survive a
 * reload (which is why the stamp is an org id and not a session counter).
 */
import '@testing-library/jest-dom';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import type { Org } from './org-scope';
import { readOrgStamp, useScopedNavigate, useStaleScopeGuard } from './scoped-nav';

const ORG_A: Org = { id: 'org-a', name: 'Acme', initials: 'AC', subtitle: null };
const ORG_B: Org = { id: 'org-b', name: 'Beta', initials: 'BE', subtitle: null };

let scope: { currentOrg: Org | null; scopeStatus: string } = {
  currentOrg: ORG_A,
  scopeStatus: 'ready',
};

jest.mock('./org-scope', () => ({
  useOrgScope: () => ({ ...scope, switchOrg: jest.fn(), retry: jest.fn() }),
}));

/** Captured from inside the router so tests can drive the real hook. */
let scopedNavigate: ReturnType<typeof useScopedNavigate> | undefined;

/**
 * Minimal app: a layout that runs the guard, plus three tab-shaped routes.
 *
 * `seed` pushes an entry *with history state* before the router is
 * constructed — `createMemoryHistory` only accepts plain path strings, and
 * pre-seeding is what models "these entries existed before this session".
 */
function buildRouter(path: string, state?: Record<string, unknown>) {
  const history = createMemoryHistory({ initialEntries: ['/passwords'] });
  if (state) history.push(path, state);
  else if (path !== '/passwords') history.push(path);

  const rootRoute = createRootRoute({ component: () => <Outlet /> });

  const layout = createRoute({
    getParentRoute: () => rootRoute,
    id: 'layout',
    component: function Layout() {
      useStaleScopeGuard();
      scopedNavigate = useScopedNavigate();
      return <Outlet />;
    },
  });

  const screens = [
    { path: '/passwords', name: 'passwords-root' },
    { path: '/passwords/$id', name: 'password-detail' },
    { path: '/assets', name: 'assets-root' },
  ].map(({ path: p, name }) =>
    createRoute({
      getParentRoute: () => layout,
      path: p,
      component: () => <div data-testid="screen">{name}</div>,
    }),
  );

  return createRouter({
    routeTree: rootRoute.addChildren([layout.addChildren(screens)]),
    history,
  });
}

async function mount(path: string, state?: Record<string, unknown>) {
  const router = buildRouter(path, state);
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByTestId('screen')).toBeInTheDocument());
  return router;
}

beforeEach(() => {
  scope = { currentOrg: ORG_A, scopeStatus: 'ready' };
  scopedNavigate = undefined;
});

describe('readOrgStamp', () => {
  it('distinguishes "no stamp" from "stamped null"', () => {
    // The difference decides whether the guard runs at all: an unstamped
    // entry is a first load or an external deep link, while a `null` stamp
    // is a real scope (a user with no visible orgs).
    expect(readOrgStamp(undefined)).toBeUndefined();
    expect(readOrgStamp({})).toBeUndefined();
    expect(readOrgStamp({ orgId: null })).toBeNull();
    expect(readOrgStamp({ orgId: 'org-a' })).toBe('org-a');
  });

  it('ignores a non-string stamp', () => {
    expect(readOrgStamp({ orgId: 42 })).toBeUndefined();
    expect(readOrgStamp('nonsense')).toBeUndefined();
  });
});

describe('useScopedNavigate', () => {
  it('stamps the current org on every navigation', async () => {
    const router = await mount('/passwords');

    scopedNavigate!({ to: '/assets' });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/assets'),
    );
    expect(readOrgStamp(router.state.location.state)).toBe(ORG_A.id);
  });

  it('honours an explicit orgId over the one in context', async () => {
    // This is what `switchOrg` relies on: it navigates on the same tick as
    // the state update, when the context in this closure still holds the
    // OLD org. Without the override the first post-switch entry would be
    // stamped stale and the guard would bounce the user immediately.
    const router = await mount('/passwords');

    scopedNavigate!({ to: '/assets', orgId: ORG_B.id });

    await waitFor(() =>
      expect(readOrgStamp(router.state.location.state)).toBe(ORG_B.id),
    );
  });

  it('can stamp null, for a user with no visible orgs', async () => {
    const router = await mount('/passwords');

    scopedNavigate!({ to: '/assets', orgId: null });

    await waitFor(() =>
      expect(readOrgStamp(router.state.location.state)).toBeNull(),
    );
  });

  it('pushes by default and replaces when asked', async () => {
    // This is what makes the back button close a sheet: the shell opens
    // overlays with a push (so there is an entry to pop) and closes them
    // with a replace (so back does not immediately re-open them). Getting
    // it backwards makes back leave the screen instead.
    const router = await mount('/passwords');
    const before = router.history.length;

    scopedNavigate!({ to: '/assets' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/assets'));
    expect(router.history.length).toBe(before + 1);

    scopedNavigate!({ to: '/passwords', replace: true });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/passwords'),
    );
    expect(router.history.length).toBe(before + 1);
  });
});

describe('useStaleScopeGuard', () => {
  it('leaves a matching entry alone', async () => {
    await mount('/passwords/abc', { orgId: ORG_A.id });
    expect(screen.getByTestId('screen')).toHaveTextContent('password-detail');
  });

  it('redirects an entry stamped with a previous org to the tab root', async () => {
    // The core case: this history entry was created while scoped to org B,
    // and the app is now scoped to org A.
    const router = await mount('/passwords/abc', { orgId: ORG_B.id });

    await waitFor(() =>
      expect(screen.getByTestId('screen')).toHaveTextContent('passwords-root'),
    );
    // Root of the tab the stale path belonged to, not a generic landing.
    expect(router.state.location.pathname).toBe('/passwords');
  });

  it('re-stamps after redirecting, so it cannot loop', async () => {
    const router = await mount('/assets', { orgId: ORG_B.id });

    await waitFor(() =>
      expect(readOrgStamp(router.state.location.state)).toBe(ORG_A.id),
    );
    expect(router.state.location.pathname).toBe('/assets');
  });

  it('ADOPTS an unstamped entry rather than exempting it', async () => {
    // A deep link or first load is legitimate right now, so it stays put —
    // but it must be stamped, not waved through. An exempt entry would be
    // exempt *forever*: navigate on, switch org, then hold back until this
    // entry comes round again and it would render the old org's detail
    // screen under the new org's header.
    const router = await mount('/passwords/abc');

    expect(screen.getByTestId('screen')).toHaveTextContent('password-detail');
    expect(router.state.location.pathname).toBe('/passwords/abc');
    await waitFor(() =>
      expect(readOrgStamp(router.state.location.state)).toBe(ORG_A.id),
    );
  });

  it('adopts without adding a history entry', async () => {
    const router = await mount('/passwords/abc');
    const length = router.history.length;

    await waitFor(() =>
      expect(readOrgStamp(router.state.location.state)).toBe(ORG_A.id),
    );

    // `replace`, not push — adopting must not give the user an extra press
    // of back to get out of.
    expect(router.history.length).toBe(length);
  });

  it('preserves search params when adopting', async () => {
    // The org sheet lives in `?sheet=org`. Adopting must not close it.
    const router = buildRouter('/passwords', undefined);
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId('screen')).toBeInTheDocument());

    await router.navigate({ to: '/assets', search: { keep: '1' } } as never);
    await waitFor(() => expect(router.state.location.pathname).toBe('/assets'));

    await waitFor(() =>
      expect(readOrgStamp(router.state.location.state)).toBe(ORG_A.id),
    );
    expect(router.state.location.search).toMatchObject({ keep: '1' });
  });

  it('an adopted entry is then caught by a later org switch', async () => {
    // The whole point of adopting: once stamped, the normal staleness check
    // applies to it like any other entry.
    const router = await mount('/passwords/abc');
    await waitFor(() =>
      expect(readOrgStamp(router.state.location.state)).toBe(ORG_A.id),
    );

    // Simulate the switch: scope becomes org B while this entry says org A.
    scope = { currentOrg: ORG_B, scopeStatus: 'ready' };
    await router.navigate({
      to: '/passwords/abc',
      state: (prev: Record<string, unknown>) => ({ ...prev, orgId: ORG_A.id }),
    } as never);

    await waitFor(() =>
      expect(screen.getByTestId('screen')).toHaveTextContent('passwords-root'),
    );
  });

  it('does not adopt while scope is still resolving', async () => {
    // Stamping with a null org before resolution finishes would be a lie
    // that the guard then acts on.
    scope = { currentOrg: null, scopeStatus: 'resolving' };
    const router = await mount('/passwords/abc');

    expect(readOrgStamp(router.state.location.state)).toBeUndefined();
    expect(screen.getByTestId('screen')).toHaveTextContent('password-detail');
  });

  it('stands down while scope is still resolving', async () => {
    // During resolution `currentOrg` is null, so every stamped entry would
    // look stale and a plain reload would bounce to a tab root.
    scope = { currentOrg: null, scopeStatus: 'resolving' };

    await mount('/passwords/abc', { orgId: ORG_A.id });

    expect(screen.getByTestId('screen')).toHaveTextContent('password-detail');
  });

  it('stands down on a scope error — a network failure is not a scope change', async () => {
    scope = { currentOrg: null, scopeStatus: 'error' };

    await mount('/passwords/abc', { orgId: ORG_A.id });

    expect(screen.getByTestId('screen')).toHaveTextContent('password-detail');
  });

  it('redirects a stamped entry when the user now has no org at all', async () => {
    scope = { currentOrg: null, scopeStatus: 'ready' };

    await mount('/passwords/abc', { orgId: ORG_A.id });

    await waitFor(() =>
      expect(screen.getByTestId('screen')).toHaveTextContent('passwords-root'),
    );
  });

  it('survives a reload — the stamp is an id, not a session counter', async () => {
    // A counter restarts at zero on reload, so pre-reload entries would
    // collide with post-reload numbering: some stale entries reading as
    // current and vice versa. This is that scenario — a fresh router (new
    // "session") over a history entry stamped before it existed.
    await mount('/passwords/abc', { orgId: ORG_B.id });

    await waitFor(() =>
      expect(screen.getByTestId('screen')).toHaveTextContent('passwords-root'),
    );
  });
});
