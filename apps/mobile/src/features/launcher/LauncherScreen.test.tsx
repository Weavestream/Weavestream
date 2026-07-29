/**
 * @jest-environment jsdom
 */
/**
 * The launcher's contracts (Phase 5b):
 *
 *  - Order: cross-org search entry first, Pinned, then All
 *    organizations with Show more.
 *  - Selecting an org is a PUSH with the org id stamped explicitly —
 *    the launcher stays in history so system Back returns to it.
 *  - Zero orgs is one honest empty state; search and sign-out survive.
 *  - Sign-out failure is told, not swallowed (the session is still
 *    live), matching MoreTab.
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LauncherScreen } from './LauncherScreen';

const navigateMock = jest.fn();
const switchOrgMock = jest.fn();

jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({
    currentOrg: null,
    scopeStatus: 'ready',
    switchOrg: switchOrgMock,
    clearOrg: jest.fn(),
    retry: jest.fn(),
  }),
  toOrg: (row: { id: string; name: string; city?: string | null }) => ({
    id: row.id,
    name: row.name,
    initials: row.name.slice(0, 2).toUpperCase(),
    subtitle: row.city ?? null,
  }),
}));

jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));

jest.mock('../../lib/sign-out', () => ({ signOutAndReset: jest.fn() }));
const { signOutAndReset } = jest.requireMock('../../lib/sign-out') as {
  signOutAndReset: jest.Mock;
};

jest.mock('../../lib/api', () => ({ apiFetch: jest.fn() }));
const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

function route(handlers: {
  companies?: { items: unknown[]; nextCursor?: string | null };
  stars?: { items: unknown[] };
}) {
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith('/companies')) {
      return Promise.resolve(handlers.companies ?? { items: [], nextCursor: null });
    }
    if (path.startsWith('/me/stars')) {
      return Promise.resolve(handlers.stars ?? { items: [] });
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderLauncher() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <Wrapper>
      <LauncherScreen />
    </Wrapper>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LauncherScreen', () => {
  it('renders pinned stars and the full org list with Show more', async () => {
    route({
      companies: {
        items: [
          { id: 'org-a', name: 'Acme Dental', archivedAt: null, city: 'Portland' },
          { id: 'org-b', name: 'Beta Clinic', archivedAt: null, city: null },
        ],
        nextCursor: 'cursor-2',
      },
      stars: {
        items: [
          { type: 'company', companyId: 'org-s', companyName: 'Starred Co', archivedAt: null },
        ],
      },
    });

    renderLauncher();

    await waitFor(() => expect(screen.getByText('Starred Co')).toBeInTheDocument());
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('All organizations')).toBeInTheDocument();
    expect(screen.getByText('Acme Dental')).toBeInTheDocument();
    expect(screen.getByText('Show more')).toBeInTheDocument();
  });

  it('entering an org switches scope and PUSHES the org root with an explicit stamp', async () => {
    route({
      companies: {
        items: [{ id: 'org-a', name: 'Acme Dental', archivedAt: null }],
        nextCursor: null,
      },
    });

    renderLauncher();
    await waitFor(() => expect(screen.getByText('Acme Dental')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Acme Dental'));

    expect(switchOrgMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'org-a' }),
    );
    // Push (replace: false) keeps the launcher in history; the explicit
    // orgId stamp is what stops the guard bouncing the first entry.
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords',
      orgId: 'org-a',
      replace: false,
    });
  });

  it('the search entry pushes global search with upIsBack so Done pops back here', async () => {
    route({});
    renderLauncher();

    fireEvent.click(screen.getByText('Search all organizations'));

    expect(navigateMock).toHaveBeenCalledWith({ to: '/search', upIsBack: true });
  });

  it('zero orgs: one empty state, search and sign-out still available', async () => {
    route({ companies: { items: [], nextCursor: null }, stars: { items: [] } });

    renderLauncher();

    await waitFor(() =>
      expect(
        screen.getByText(/No organizations available/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Search all organizations')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('a failed sign-out shows the error instead of pretending', async () => {
    route({});
    signOutAndReset.mockResolvedValueOnce({ ok: false, message: 'Couldn’t reach the server.' });

    renderLauncher();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() =>
      expect(screen.getByText('Couldn’t reach the server.')).toBeInTheDocument(),
    );
  });
});
