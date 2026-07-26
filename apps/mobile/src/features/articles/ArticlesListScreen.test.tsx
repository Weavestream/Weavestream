/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ArticlesListScreen } from './ArticlesListScreen';
import { makeArticle, makeFolderNode } from './test-fixtures';

const navigateMock = jest.fn();

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
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const PAGE1 = [
  makeArticle({ id: 'a0000000-0000-4000-8000-0000000000a1', title: 'Pines site reboot order' }),
  makeArticle({
    id: 'a0000000-0000-4000-8000-0000000000a2',
    title: 'Switch stack replacement',
    updatedByUser: null,
  }),
];
const PAGE2 = [
  makeArticle({ id: 'a0000000-0000-4000-8000-0000000000a3', title: 'Zebra printer setup' }),
];

const FOLDERS = [
  makeFolderNode({
    id: 'f0000000-0000-4000-8000-0000000000f1',
    name: 'Network',
    children: [
      makeFolderNode({
        id: 'f0000000-0000-4000-8000-0000000000f2',
        name: 'Docs',
        parentId: 'f0000000-0000-4000-8000-0000000000f1',
      }),
    ],
  }),
];

function route({
  page2Fails = false,
  hasMore = true,
}: { page2Fails?: boolean; hasMore?: boolean } = {}) {
  apiFetch.mockImplementation((path: string) => {
    if (path.includes('/folders')) return Promise.resolve({ items: FOLDERS });
    if (path.includes('/articles')) {
      if (path.includes('cursor=')) {
        return page2Fails
          ? Promise.reject(new Error('network down'))
          : Promise.resolve({ items: PAGE2, nextCursor: null });
      }
      return Promise.resolve({
        items: PAGE1,
        nextCursor: hasMore ? PAGE1[PAGE1.length - 1]!.id : null,
      });
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderList(filter: { folder?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const utils = render(
    <Wrapper>
      <ArticlesListScreen filter={filter} />
    </Wrapper>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  jest.clearAllMocks();
  route();
});

describe('ArticlesListScreen rows', () => {
  it('renders title, updated date, and author; degrades to date-only for deleted authors', async () => {
    renderList();
    expect(await screen.findByText('Pines site reboot order')).toBeInTheDocument();
    expect(screen.getByText(/Updated .+ · A\. Reyes/)).toBeInTheDocument();
    // updatedByUser: null → no dangling separator
    const bare = screen.getAllByText(/^Updated /).find((el) => !/·/.test(el.textContent ?? ''));
    expect(bare).toBeDefined();
  });

  it('opens the detail with the upIsBack stamp', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: /Pines site reboot order/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/articles/a0000000-0000-4000-8000-0000000000a1',
      upIsBack: true,
    });
  });
});

describe('ArticlesListScreen folder chips', () => {
  it('shows breadcrumb labels and re-queries server-side on tap', async () => {
    renderList();
    const chip = await screen.findByRole('button', { name: 'Network / Docs' });
    fireEvent.click(chip);
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/articles',
      replace: true,
      search: { folder: 'f0000000-0000-4000-8000-0000000000f2' },
    });
  });

  it('passes the active folder filter to the API as folderId', async () => {
    renderList({ folder: 'f0000000-0000-4000-8000-0000000000f2' });
    await screen.findByText('Pines site reboot order');
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('folderId=f0000000-0000-4000-8000-0000000000f2'),
      expect.anything(),
    );
  });

  it('shows the folder-specific empty state', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.includes('/folders')) return Promise.resolve({ items: FOLDERS });
      return Promise.resolve({ items: [], nextCursor: null });
    });
    renderList({ folder: 'f0000000-0000-4000-8000-0000000000f2' });
    expect(await screen.findByText('No articles in this folder.')).toBeInTheDocument();
  });
});

describe('ArticlesListScreen pagination', () => {
  it('loads the next page with the last row id as cursor and appends', async () => {
    renderList();
    const more = await screen.findByRole('button', { name: 'Show more' });
    fireEvent.click(more);
    expect(await screen.findByText('Zebra printer setup')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('cursor=a0000000-0000-4000-8000-0000000000a2'),
      expect.anything(),
    );
    // Page 1 rows are still there — appended, not replaced.
    expect(screen.getByText('Pines site reboot order')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('keeps loaded rows and offers inline retry when a later page fails', async () => {
    route({ page2Fails: true });
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    // The inline footer error appears; the full-screen banner does not.
    expect(await screen.findByText('Couldn’t load more.')).toBeInTheDocument();
    expect(screen.getByText('Pines site reboot order')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Retry re-issues the page-2 fetch.
    route({ page2Fails: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Zebra printer setup')).toBeInTheDocument();
  });

  it('hides the footer entirely when there is no next page', async () => {
    route({ hasMore: false });
    renderList();
    await screen.findByText('Pines site reboot order');
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});

describe('ArticlesListScreen background refetch failure', () => {
  it('keeps cached rows under a refresh banner instead of replacing them', async () => {
    const { client } = renderList();
    await screen.findByText('Pines site reboot order');

    // Articles begin failing; folders keep succeeding. This is the
    // window-focus/reconnect refetch path, not a next-page fetch.
    apiFetch.mockImplementation((path: string) => {
      if (path.includes('/folders')) return Promise.resolve({ items: FOLDERS });
      return Promise.reject(new Error('network down'));
    });
    await act(async () => {
      await client.refetchQueries().catch(() => {});
    });

    // The stale banner appears (findBy*: TanStack notifies observers
    // asynchronously, after act's flush)…
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t refresh.');
    // …while the rows survive the failed refetch, and the full-screen
    // load error stays away.
    expect(screen.getByText('Pines site reboot order')).toBeInTheDocument();
    expect(screen.getByText('Switch stack replacement')).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t load articles.')).not.toBeInTheDocument();

    // Its retry is refetch(): recovery clears the banner in place.
    route();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('Pines site reboot order')).toBeInTheDocument();
  });
});

describe('ArticlesListScreen first-load failure', () => {
  it('shows the full-screen banner with retry when nothing loaded', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.includes('/folders')) return Promise.resolve({ items: [] });
      return Promise.reject(new Error('network down'));
    });
    renderList();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load articles.');

    route();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByText('Pines site reboot order')).toBeInTheDocument(),
    );
  });
});
