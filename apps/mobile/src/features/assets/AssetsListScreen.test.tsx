/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AssetsListScreen } from './AssetsListScreen';
import {
  FIXTURE_LAYOUT_ID,
  makeAsset,
  makeAssetsPage,
  makeLayout,
} from './test-fixtures';

const navigateMock = jest.fn();
const accessMock = { canWrite: true, isClientUser: false };

jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({
    currentOrg: {
      id: 'c0000000-0000-4000-8000-0000000000c1',
      name: 'Enterprise Title',
      initials: 'ET',
      subtitle: null,
    },
    scopeStatus: 'ready',
    switchOrg: jest.fn(),
    retry: jest.fn(),
  }),
}));
jest.mock('../../screens/TabShell', () => ({
  useOpenOrgSheet: () => jest.fn(),
}));
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
jest.mock('../../lib/use-online', () => ({ useOnline: () => true }));
jest.mock('../../lib/use-company-access', () => ({
  useCompanyAccess: () => accessMock,
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const OTHER_LAYOUT = makeLayout({
  id: 'd0000000-0000-4000-8000-0000000000d9',
  name: 'Printers',
  slug: 'printers',
});
const LAYOUTS = [makeLayout(), OTHER_LAYOUT];
// Printers has zero assets in this org → no chip for it.
const COUNTS = { [FIXTURE_LAYOUT_ID]: 3 };

const PAGE1 = [
  makeAsset({
    id: 'b0000000-0000-4000-8000-0000000000b1',
    name: 'srv-pines-01',
    fieldValues: { hostname: 'srv-pines-01', mgmt_ip: '10.20.0.5' },
  }),
  makeAsset({
    id: 'b0000000-0000-4000-8000-0000000000b2',
    name: 'srv-pines-02',
    fieldValues: {},
  }),
];
const PAGE2 = [
  makeAsset({ id: 'b0000000-0000-4000-8000-0000000000b3', name: 'zebra-print-01' }),
];

function route({
  page2Fails = false,
  hasMore = true,
}: { page2Fails?: boolean; hasMore?: boolean } = {}) {
  apiFetch.mockImplementation((path: string) => {
    if (path === '/layouts') return Promise.resolve({ items: LAYOUTS });
    if (path.includes('/counts-by-layout')) return Promise.resolve(COUNTS);
    if (path.includes('/assets')) {
      if (path.includes('cursor=')) {
        return page2Fails
          ? Promise.reject(new Error('network down'))
          : Promise.resolve(makeAssetsPage(PAGE2, null));
      }
      return Promise.resolve(
        makeAssetsPage(PAGE1, hasMore ? PAGE1[PAGE1.length - 1]!.id : null),
      );
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderList(filter: { layout?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const utils = render(
    <Wrapper>
      <AssetsListScreen filter={filter} />
    </Wrapper>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  jest.clearAllMocks();
  accessMock.canWrite = true;
  accessMock.isClientUser = false;
  route();
});

describe('AssetsListScreen rows', () => {
  it('renders name plus one meta line from card fields, deduped against the title', async () => {
    renderList();
    expect(await screen.findByText('srv-pines-01')).toBeInTheDocument();
    // Primary equals the name → deduped; the showInTable IP remains.
    expect(screen.getByText('10.20.0.5')).toBeInTheDocument();
    // No card values at all → the layout name stands in.
    expect(screen.getByText('Servers')).toBeInTheDocument();
  });

  it('opens the detail with the upIsBack stamp', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: /srv-pines-01/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/assets/b0000000-0000-4000-8000-0000000000b1',
      upIsBack: true,
    });
  });

  it('shows the New button only for managers', async () => {
    renderList();
    expect(await screen.findByRole('button', { name: /New/ })).toBeInTheDocument();
  });

  it('hides the New button for client users', async () => {
    accessMock.isClientUser = true;
    renderList();
    await screen.findByText('srv-pines-01');
    expect(screen.queryByRole('button', { name: /New/ })).not.toBeInTheDocument();
  });
});

describe('AssetsListScreen layout chips', () => {
  it('renders All with the org total and one counted chip per non-zero layout', async () => {
    renderList();
    expect(await screen.findByRole('button', { name: 'All 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Servers 3' })).toBeInTheDocument();
    // Zero assets in this org → no chip, even though the layout exists.
    expect(screen.queryByRole('button', { name: /Printers/ })).not.toBeInTheDocument();
  });

  it('chip taps re-query server-side with replace navigation', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Servers 3' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/assets',
      replace: true,
      search: { layout: FIXTURE_LAYOUT_ID },
    });
  });

  it('passes the active layout filter to the API and keeps its chip at zero count', async () => {
    renderList({ layout: OTHER_LAYOUT.id });
    await screen.findByText('srv-pines-01');
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining(`layout=${OTHER_LAYOUT.id}`),
      expect.anything(),
    );
    // Selected-but-empty layout still gets its chip so the filter can be cleared.
    expect(screen.getByRole('button', { name: 'Printers 0' })).toBeInTheDocument();
  });

  it('layout-filtered empty state has its own copy', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/layouts') return Promise.resolve({ items: LAYOUTS });
      if (path.includes('/counts-by-layout')) return Promise.resolve(COUNTS);
      return Promise.resolve(makeAssetsPage([], null));
    });
    renderList({ layout: FIXTURE_LAYOUT_ID });
    expect(await screen.findByText('No assets in this layout.')).toBeInTheDocument();
  });

  it('a failed layouts query never blanks the rows — chips are simply absent', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/layouts') return Promise.reject(new Error('boom'));
      if (path.includes('/counts-by-layout')) return Promise.resolve(COUNTS);
      return Promise.resolve(makeAssetsPage(PAGE1, null));
    });
    renderList();
    expect(await screen.findByText('srv-pines-01')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /All/ })).not.toBeInTheDocument();
  });
});

describe('AssetsListScreen pagination', () => {
  it('loads the next page with the last row id as cursor and appends', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('zebra-print-01')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('cursor=b0000000-0000-4000-8000-0000000000b2'),
      expect.anything(),
    );
    expect(screen.getByText('srv-pines-01')).toBeInTheDocument();
  });

  it('keeps loaded rows and offers inline retry when a later page fails', async () => {
    route({ page2Fails: true });
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Couldn’t load more.')).toBeInTheDocument();
    expect(screen.getByText('srv-pines-01')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    route({ page2Fails: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('zebra-print-01')).toBeInTheDocument();
  });
});

describe('AssetsListScreen error states', () => {
  it('first-load failure shows the full banner with retry', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/layouts') return Promise.resolve({ items: LAYOUTS });
      if (path.includes('/counts-by-layout')) return Promise.resolve(COUNTS);
      return Promise.reject(new Error('network down'));
    });
    renderList();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load assets.');

    route();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('srv-pines-01')).toBeInTheDocument());
  });

  it('a failed refetch keeps rows under the refresh banner', async () => {
    const { client } = renderList();
    await screen.findByText('srv-pines-01');

    apiFetch.mockImplementation((path: string) => {
      if (path === '/layouts') return Promise.resolve({ items: LAYOUTS });
      if (path.includes('/counts-by-layout')) return Promise.resolve(COUNTS);
      return Promise.reject(new Error('network down'));
    });
    await act(async () => {
      await client.refetchQueries().catch(() => {});
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t refresh.');
    expect(screen.getByText('srv-pines-01')).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t load assets.')).not.toBeInTheDocument();
  });
});
