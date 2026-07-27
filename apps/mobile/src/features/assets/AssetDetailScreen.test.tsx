/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { AssetDetailScreen } from './AssetDetailScreen';
import { makeAsset, makeCredential, makeProvenance } from './test-fixtures';

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
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
jest.mock('../../lib/use-online', () => ({ useOnline: () => true }));
jest.mock('../../lib/use-company-access', () => ({
  useCompanyAccess: () => accessMock,
}));
jest.mock('../../lib/use-back', () => ({
  useBackOr: () => jest.fn(),
  useBackLabel: (label: string) => label,
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const ORG = 'c0000000-0000-4000-8000-0000000000c1';
const ASSET_ID = 'b0000000-0000-4000-8000-0000000000b1';

function route({
  detail = makeAsset(),
  relations = { asset: [], article: [], password: [] },
  credentials = [] as unknown[],
  detailError = null as ApiError | null,
}: {
  detail?: ReturnType<typeof makeAsset>;
  relations?: Record<string, unknown[]>;
  credentials?: unknown[];
  detailError?: ApiError | null;
} = {}) {
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      return Promise.resolve(makeAsset({ archivedAt: '2026-07-26T10:00:00.000Z' }));
    }
    if (path.endsWith('/restore')) return Promise.resolve(makeAsset());
    if (path.includes('/relations')) return Promise.resolve({ groups: relations });
    if (path.includes('/passwords')) return Promise.resolve({ items: credentials });
    if (path.includes('/assets/')) {
      return detailError ? Promise.reject(detailError) : Promise.resolve(detail);
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderDetail(assetId = ASSET_ID) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  const utils = render(
    <Wrapper>
      <AssetDetailScreen assetId={assetId} />
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

describe('AssetDetailScreen guards', () => {
  it('renders not-found for a malformed id without a single fetch', () => {
    renderDetail('not-a-uuid');
    expect(screen.getByText(/wasn’t found/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('404 renders not-found; 403 renders the restricted copy; other errors retry', async () => {
    route({ detailError: new ApiError(404, {}) });
    const first = renderDetail();
    expect(await screen.findByText(/wasn’t found/)).toBeInTheDocument();
    first.unmount();

    route({ detailError: new ApiError(403, {}) });
    const second = renderDetail();
    expect(
      await second.findByText('You don’t have access to this asset.'),
    ).toBeInTheDocument();
    second.unmount();

    route({ detailError: new ApiError(500, {}) });
    renderDetail();
    expect(await screen.findByText('Couldn’t load this asset.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('AssetDetailScreen content', () => {
  it('renders every layout field in order with the layout identity line', async () => {
    renderDetail();
    expect(
      await screen.findByRole('heading', { name: 'srv-pines-01' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Servers')).toBeInTheDocument();
    // Every field label renders, including the empty RICH_TEXT one.
    expect(screen.getByText('Hostname')).toBeInTheDocument();
    expect(screen.getByText('Management IP')).toBeInTheDocument();
    expect(screen.getByText('Runbook')).toBeInTheDocument();
    expect(screen.getByText('10.20.0.5')).toBeInTheDocument();
  });

  it('folds linked credentials into Related as navigable password rows, deduped and active-only', async () => {
    route({
      relations: {
        asset: [],
        article: [],
        password: [
          {
            relationId: 'r1',
            kind: 'password',
            id: 'e0000000-0000-4000-8000-0000000000e1',
            title: 'iDRAC (linked manually)',
            subtitle: null,
          },
        ],
      },
      credentials: [
        makeCredential({ id: 'e0000000-0000-4000-8000-0000000000e1', name: 'iDRAC' }),
        makeCredential({ id: 'e0000000-0000-4000-8000-0000000000e2', name: 'BMC', username: 'admin' }),
        makeCredential({
          id: 'e0000000-0000-4000-8000-0000000000e3',
          name: 'Old cred',
          archivedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    });
    renderDetail();

    // Relation row wins the dedupe; the embedded credential appends.
    expect(await screen.findByText('iDRAC (linked manually)')).toBeInTheDocument();
    expect(screen.queryByText(/^iDRAC$/)).not.toBeInTheDocument();
    // Archived credential filtered out.
    expect(screen.queryByText('Old cred')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /BMC/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords/e0000000-0000-4000-8000-0000000000e2',
    });
  });

  it('shows T2 metadata behind Show more with sync rows and the provenance dot', async () => {
    route({
      detail: makeAsset({
        externalSource: 'action1',
        externalId: 'EP-441',
        syncSources: [
          {
            integrationId: 'i1',
            integrationName: 'Action1 (HQ)',
            driver: 'action1',
            resourceKey: 'endpoints',
            lastSyncedAt: '2026-07-20T09:00:00.000Z',
          },
        ],
        provenance: [makeProvenance({ state: 'blocked' })],
      }),
    });
    renderDetail();
    const toggle = await screen.findByRole('button', { name: /Show more/ });
    // The attention dot rides the collapsed label (blocked → review copy).
    expect(toggle).toHaveAccessibleName(/needs review/i);
    fireEvent.click(toggle);

    // Time rendering is viewer-zone; assert the zone-independent prefix.
    expect(screen.getByText(/^Action1 \(HQ\) \(action1\) · /)).toBeInTheDocument();
    expect(screen.getByText('action1')).toBeInTheDocument();
    expect(screen.getByText('EP-441')).toBeInTheDocument();
    expect(screen.getByText('Sync blocked')).toBeInTheDocument();
    // Created and Updated both carry the actor name.
    expect(screen.getAllByText(/· A\. Reyes/)).toHaveLength(2);
  });
});

describe('AssetDetailScreen archive/restore', () => {
  it('archive confirms via the sheet, fires once under rapid confirm taps, toasts, and invalidates passwords + relations', async () => {
    const { client } = renderDetail();
    const spy = jest.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Archive asset' }));

    // The header tap only opens the sheet; the sheet's Archive commits.
    expect(
      apiFetch.mock.calls.filter(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(0);
    expect(
      screen.getByRole('dialog', { name: 'Archive asset?' }),
    ).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: 'Archive' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText('Asset archived');

    const deletes = apiFetch.mock.calls.filter(
      ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deletes).toHaveLength(1);

    const invalidated = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(['assets', ORG]));
    expect(invalidated).toContain(JSON.stringify(['relations', ORG]));
    expect(invalidated).toContain(JSON.stringify(['passwords', ORG]));
  });

  it('cancelling the confirmation archives nothing', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive asset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('dialog', { name: 'Archive asset?' }),
    ).not.toBeInTheDocument();
    expect(
      apiFetch.mock.calls.filter(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(0);
  });

  it('archived assets render the banner with Restore (never an error), and restore invalidates too', async () => {
    route({ detail: makeAsset({ archivedAt: '2026-07-01T00:00:00.000Z' }) });
    const { client } = renderDetail();
    const spy = jest.spyOn(client, 'invalidateQueries');

    expect(await screen.findByText('This asset is archived.')).toBeInTheDocument();
    // No Edit/Archive actions on an archived asset.
    expect(screen.queryByRole('button', { name: 'Edit asset' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByText('Asset restored');
    const invalidated = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(['relations', ORG]));
    expect(invalidated).toContain(JSON.stringify(['passwords', ORG]));
  });

  it('withholds manage actions from client users', async () => {
    accessMock.isClientUser = true;
    renderDetail();
    await screen.findByRole('heading', { name: 'srv-pines-01' });
    expect(screen.queryByRole('button', { name: 'Edit asset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive asset' })).not.toBeInTheDocument();
  });

  it('Edit navigates to the edit route with upIsBack', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit asset' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: `/assets/${ASSET_ID}/edit`,
      upIsBack: true,
    });
  });
});
