/**
 * @jest-environment jsdom
 */
/**
 * The org switcher's two contracts:
 *
 *  - Pinned is **complete**, because it comes from `/me/stars` rather than
 *    from the paginated list's per-page `isStarred` flag. A starred org on
 *    page 3 must still appear.
 *  - Archived stars are hidden — a star can outlive the company it points
 *    at, and scoping the app to a decommissioned client is a dead end.
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OrgSheet } from './OrgSheet';
import type { Org } from '../lib/org-scope';

const onSelect = jest.fn();
let currentOrg: Org | null = {
  id: 'org-current',
  name: 'Enterprise Title',
  initials: 'ET',
  subtitle: 'Portland, OR',
};

jest.mock('../lib/org-scope', () => ({
  useOrgScope: () => ({
    currentOrg,
    scopeStatus: 'ready',
    switchOrg: jest.fn(),
    retry: jest.fn(),
  }),
  toOrg: (row: { id: string; name: string; city?: string | null }) => ({
    id: row.id,
    name: row.name,
    initials: row.name.slice(0, 2).toUpperCase(),
    subtitle: row.city ?? null,
  }),
}));

jest.mock('../lib/api', () => ({ apiFetch: jest.fn() }));
const { apiFetch } = jest.requireMock('../lib/api') as { apiFetch: jest.Mock };

function renderSheet(onClose = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    onClose,
    ...render(
      <Wrapper>
        <OrgSheet open onClose={onClose} onSelect={onSelect} />
      </Wrapper>,
    ),
  };
}

/** Route each mocked call by its path, so page/star order doesn't matter. */
function route(handlers: {
  companies?: { items: unknown[]; nextCursor?: string | null };
  stars?: { items: unknown[] };
}) {
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith('/companies')) {
      return Promise.resolve(
        handlers.companies ?? { items: [], nextCursor: null },
      );
    }
    if (path.startsWith('/me/stars')) {
      return Promise.resolve(handlers.stars ?? { items: [] });
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

const star = (over: Record<string, unknown> = {}) => ({
  type: 'company',
  companyId: 'org-starred',
  companyName: 'Harbor Ridge Schools',
  archivedAt: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  currentOrg = {
    id: 'org-current',
    name: 'Enterprise Title',
    initials: 'ET',
    subtitle: 'Portland, OR',
  };
});

describe('OrgSheet', () => {
  it('is a labelled modal dialog', async () => {
    route({});
    renderSheet();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Organizations');
  });

  it('never auto-focuses the filter input on open (the on-screen keyboard must not pop)', async () => {
    route({});
    renderSheet();

    await screen.findByRole('dialog');
    // Auto-selecting fields is banned app-wide: focusing the filter on
    // open raised the phone keyboard over the sheet. The Sheet's focus
    // containment lands on the close button instead.
    expect(screen.getByLabelText('Filter organizations')).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close Organizations' })).toHaveFocus();
  });

  it('shows a starred org that the first page of the list never returns', async () => {
    // The bug: `/companies` computes `isStarred` only for the slice it
    // returns, so a star beyond page 1 would silently vanish from Pinned.
    route({
      companies: { items: [{ id: 'org-a', name: 'Acme', city: 'Leeds' }] },
      stars: { items: [star()] },
    });

    renderSheet();

    expect(await screen.findByText('Pinned')).toBeInTheDocument();
    expect(await screen.findByText('Harbor Ridge Schools')).toBeInTheDocument();
    // And the pinned block is fed by its own request.
    expect(apiFetch).toHaveBeenCalledWith('/me/stars', expect.anything());
  });

  it('hides an archived star', async () => {
    route({
      stars: {
        items: [
          star({ companyName: 'Live Co' }),
          star({
            companyId: 'org-dead',
            companyName: 'Closed Co',
            archivedAt: '2026-01-01T00:00:00Z',
          }),
        ],
      },
    });

    renderSheet();

    expect(await screen.findByText('Live Co')).toBeInTheDocument();
    expect(screen.queryByText('Closed Co')).not.toBeInTheDocument();
  });

  it('ignores starred items that are not companies', async () => {
    route({
      stars: {
        items: [
          { type: 'password', id: 'p1', name: 'Router admin' },
          { type: 'asset', id: 'a1', name: 'RTR-01' },
          star(),
        ],
      },
    });

    renderSheet();

    expect(await screen.findByText('Harbor Ridge Schools')).toBeInTheDocument();
    expect(screen.queryByText('Router admin')).not.toBeInTheDocument();
    expect(screen.queryByText('RTR-01')).not.toBeInTheDocument();
  });

  it('marks the current org and does not offer to re-select it', async () => {
    route({});
    renderSheet();

    expect(await screen.findByText('Enterprise Title')).toBeInTheDocument();
    expect(screen.getByText('Current organization')).toBeInTheDocument();
    // No tap target on the row you are already in.
    expect(
      screen.queryByRole('button', { name: /Enterprise Title/ }),
    ).not.toBeInTheDocument();
  });

  it('does not list the current org twice when it is also starred', async () => {
    route({
      companies: { items: [{ id: 'org-current', name: 'Enterprise Title' }] },
      stars: { items: [star({ companyId: 'org-current', companyName: 'Enterprise Title' })] },
    });

    renderSheet();

    await waitFor(() =>
      expect(screen.getAllByText('Enterprise Title')).toHaveLength(1),
    );
  });

  it('hands the selected org to the shell, which owns the coordinated switch', async () => {
    // The sheet deliberately does NOT call `switchOrg` itself: switching
    // also has to navigate to the current tab's root with the new org id
    // stamped, and only the shell knows which tab is showing.
    route({
      companies: { items: [{ id: 'org-a', name: 'Acme', city: 'Leeds' }] },
    });
    renderSheet();

    fireEvent.click(await screen.findByRole('button', { name: /Acme/ }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'org-a', name: 'Acme' }),
    );
  });

  it('debounces the filter into a server-side ?q=', async () => {
    jest.useFakeTimers();
    route({ companies: { items: [] } });
    renderSheet();

    fireEvent.change(screen.getByLabelText('Filter organizations'), {
      target: { value: 'pines' },
    });
    // Not yet — the whole point of the debounce.
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('q=pines'),
      expect.anything(),
    );

    jest.advanceTimersByTime(250);
    jest.useRealTimers();

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('q=pines'),
        expect.anything(),
      ),
    );
  });

  it('drops the Pinned block while filtering', async () => {
    // Pins are for browsing; a filter is for finding. Keeping a Pinned
    // header above filtered results reads as "these matched too".
    route({
      companies: { items: [{ id: 'org-a', name: 'Acme' }] },
      stars: { items: [star()] },
    });
    renderSheet();

    expect(await screen.findByText('Pinned')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter organizations'), {
      target: { value: 'acme' },
    });

    await waitFor(() =>
      expect(screen.queryByText('Pinned')).not.toBeInTheDocument(),
    );
  });

  it('renders the zero-org empty state rather than an error', async () => {
    currentOrg = null;
    route({ companies: { items: [] }, stars: { items: [] } });

    renderSheet();

    expect(
      await screen.findByText(/No organizations available/i),
    ).toBeInTheDocument();
  });

  it('offers a retry when the list fails', async () => {
    apiFetch.mockImplementation((path: string) =>
      path.startsWith('/companies')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ items: [] }),
    );

    renderSheet();

    expect(
      await screen.findByText(/Couldn’t load organizations/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('never shows an error and "no organizations" at the same time', async () => {
    // A failed request is not an empty result. Rendering both tells the
    // technician that something broke *and* that they have no clients — one
    // of which is untrue, and they cannot tell which.
    currentOrg = null;
    apiFetch.mockImplementation((path: string) =>
      path.startsWith('/companies')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ items: [] }),
    );

    renderSheet();

    await screen.findByText(/Couldn’t load organizations/i);
    expect(
      screen.queryByText(/No organizations available/i),
    ).not.toBeInTheDocument();
  });

  it('does not claim "no matches" when a filtered request failed', async () => {
    apiFetch.mockImplementation((path: string) =>
      path.startsWith('/companies')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ items: [] }),
    );
    renderSheet();

    fireEvent.change(screen.getByLabelText('Filter organizations'), {
      target: { value: 'pines' },
    });

    await screen.findByText(/Couldn’t load organizations/i);
    await waitFor(() =>
      expect(screen.queryByText(/No organizations match/i)).not.toBeInTheDocument(),
    );
  });

  it('surfaces a stars failure instead of silently losing the pins', async () => {
    // Silence here reads as "my pinned clients are gone" rather than "that
    // request failed", and the rest of the list still works — so it gets its
    // own message rather than being folded into a whole-sheet error.
    apiFetch.mockImplementation((path: string) =>
      path.startsWith('/me/stars')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ items: [{ id: 'org-a', name: 'Acme' }] }),
    );

    renderSheet();

    expect(
      await screen.findByText(/Couldn’t load your pinned organizations/i),
    ).toBeInTheDocument();
    // And the list below is still rendered and usable.
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(
      screen.queryByText(/No organizations available/i),
    ).not.toBeInTheDocument();
  });

  it('shows one banner when both requests fail, not a contradictory pair', async () => {
    // "The full list below is unaffected" is a plain falsehood when the list
    // failed too — and two banners for one cause (the connection) is noise
    // the technician cannot act on differently.
    apiFetch.mockImplementation(() => Promise.reject(new Error('offline')));

    renderSheet();

    await screen.findByText(/Couldn’t load organizations/i);
    expect(
      screen.queryByText(/Couldn’t load your pinned organizations/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/full list below is unaffected/i),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('one Retry recovers both halves when both failed', async () => {
    // Otherwise the pinned block stays broken behind a banner that just
    // disappeared, and nothing on screen offers to fix it.
    let failing = true;
    const seen: string[] = [];
    apiFetch.mockImplementation((path: string) => {
      seen.push(path);
      if (failing) return Promise.reject(new Error('offline'));
      return Promise.resolve(
        path.startsWith('/me/stars')
          ? { items: [star()] }
          : { items: [{ id: 'org-a', name: 'Acme' }] },
      );
    });

    renderSheet();
    await screen.findByText(/Couldn’t load organizations/i);

    failing = false;
    seen.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(seen.some((p) => p.startsWith('/companies'))).toBe(true),
    );
    await waitFor(() =>
      expect(seen.some((p) => p.startsWith('/me/stars'))).toBe(true),
    );
    expect(await screen.findByText('Harbor Ridge Schools')).toBeInTheDocument();
  });

  it('hides the stars error while filtering, where pins are not shown', async () => {
    apiFetch.mockImplementation((path: string) =>
      path.startsWith('/me/stars')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ items: [{ id: 'org-a', name: 'Acme' }] }),
    );
    renderSheet();
    await screen.findByText(/Couldn’t load your pinned organizations/i);

    fireEvent.change(screen.getByLabelText('Filter organizations'), {
      target: { value: 'acme' },
    });

    await waitFor(() =>
      expect(
        screen.queryByText(/Couldn’t load your pinned organizations/i),
      ).not.toBeInTheDocument(),
    );
  });

  it('does not promise a count it cannot get', async () => {
    // The mock says "Filter 214 organizations"; the endpoint returns no
    // total, so the number is dropped rather than faked.
    route({});
    renderSheet();

    const field = await screen.findByLabelText('Filter organizations');
    expect(field).toHaveAttribute('placeholder', 'Filter organizations');
  });
});
