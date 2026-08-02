/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { AssetFormScreen } from './AssetFormScreen';
import { FIXTURE_LAYOUT_ID, makeAsset, makeLayout, makeLayoutField } from './test-fixtures';

const navigateMock = jest.fn();
const backMock = jest.fn();
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
jest.mock('../../lib/use-back', () => ({ useBackOr: () => backMock }));
jest.mock('../../lib/use-company-access', () => ({
  useCompanyAccess: () => accessMock,
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const ASSET_ID = 'b0000000-0000-4000-8000-0000000000b1';
const LAYOUT = makeLayout({
  fields: [
    makeLayoutField({
      slug: 'hostname',
      name: 'Hostname',
      isPrimary: true,
      isRequired: true,
      position: 0,
    }),
    makeLayoutField({
      slug: 'mgmt_ip',
      name: 'Management IP',
      fieldType: 'IP_ADDRESS',
      position: 1,
    }),
    makeLayoutField({ slug: 'runbook', name: 'Runbook', fieldType: 'RICH_TEXT', position: 2 }),
  ],
});

function route({
  layout = LAYOUT,
  detail = makeAsset(),
  writeError = null as ApiError | null,
}: {
  layout?: ReturnType<typeof makeLayout>;
  detail?: ReturnType<typeof makeAsset>;
  writeError?: ApiError | null;
} = {}) {
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      return writeError
        ? Promise.reject(writeError)
        : Promise.resolve(makeAsset({ id: 'b0000000-0000-4000-8000-0000000000c9' }));
    }
    if (path.startsWith('/layouts/')) return Promise.resolve({ layout });
    if (path.includes('/relations')) return Promise.resolve({ groups: {} });
    if (path.includes('/passwords')) return Promise.resolve({ items: [] });
    if (path.includes('/assets/')) return Promise.resolve(detail);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderForm(
  props: { mode: 'create'; layoutId: string } | { mode: 'edit'; assetId: string } = {
    mode: 'create',
    layoutId: FIXTURE_LAYOUT_ID,
  },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <AssetFormScreen {...props} />
    </Wrapper>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  accessMock.canWrite = true;
  accessMock.isClientUser = false;
  route();
});

describe('create', () => {
  it('POSTs {assetLayoutId, fieldValues} without a name when the override is empty', async () => {
    renderForm();
    fireEvent.change(await screen.findByLabelText('Hostname *'), {
      target: { value: 'new-host' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Asset created');
    const post = apiFetch.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === 'POST',
    )!;
    expect(JSON.parse(post[1].body as string)).toEqual({
      assetLayoutId: FIXTURE_LAYOUT_ID,
      fieldValues: { hostname: 'new-host' },
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/assets/b0000000-0000-4000-8000-0000000000c9',
      replace: true,
    });
  });

  it('blocks locally on missing required fields without a round trip', async () => {
    renderForm();
    await screen.findByLabelText('Hostname *');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Required.')).toBeInTheDocument();
    expect(
      apiFetch.mock.calls.filter(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('shows a field error and blocks saving an unsafe URL until corrected', async () => {
    route({
      layout: makeLayout({
        fields: [
          makeLayoutField({
            slug: 'hostname',
            name: 'Hostname',
            isPrimary: true,
            isRequired: true,
            position: 0,
          }),
          makeLayoutField({
            slug: 'admin_url',
            name: 'Admin URL',
            fieldType: 'URL',
            position: 1,
          }),
        ],
      }),
    });
    renderForm();
    fireEvent.change(await screen.findByLabelText('Hostname *'), {
      target: { value: 'router-1' },
    });
    const url = screen.getByLabelText('Admin URL');
    fireEvent.change(url, { target: { value: 'data:text/html,hello' } });

    expect(url).toHaveValue('data:text/html,hello');
    expect(screen.getByText(/starting with http:\/\//i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(url, { target: { value: 'https://router.example/admin' } });
    expect(screen.queryByText(/starting with http:\/\//i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('maps a 400 ValidationError onto the slug and a 409 onto the conflicting name', async () => {
    route({
      writeError: new ApiError(400, {
        error: 'ValidationError',
        issues: [{ path: 'mgmt_ip', message: 'Enter a valid IPv4 or IPv6 address.' }],
      }),
    });
    const first = renderForm();
    fireEvent.change(await screen.findByLabelText('Hostname *'), {
      target: { value: 'h' },
    });
    fireEvent.change(screen.getByLabelText('Management IP'), {
      target: { value: 'not-an-ip' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a valid IPv4 or IPv6 address.')).toBeInTheDocument();
    first.unmount();

    route({
      writeError: new ApiError(409, {
        error: 'UniqueFieldViolation',
        slug: 'hostname',
        conflictingAssetName: 'srv-pines-02',
      }),
    });
    renderForm();
    fireEvent.change(await screen.findByLabelText('Hostname *'), {
      target: { value: 'srv-pines-02' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Already used by “srv-pines-02”.')).toBeInTheDocument();
  });

  it('blocks creation on a layout with a required desktop-only field', async () => {
    route({
      layout: makeLayout({
        fields: [
          makeLayoutField({ slug: 'title', fieldType: 'TEXT', isPrimary: true }),
          makeLayoutField({ slug: 'body', name: 'Body', fieldType: 'RICH_TEXT', isRequired: true }),
        ],
      }),
    });
    renderForm();
    expect(await screen.findByText('This layout requires desktop.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Body is a required field that can only be filled in on desktop',
    );
    // No Save button at all — the chrome renders without one.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders RICH_TEXT read-only with the desktop note instead of hiding it', async () => {
    renderForm();
    await screen.findByLabelText('Hostname *');
    expect(screen.getByText('Runbook')).toBeInTheDocument();
    expect(
      screen.getByText('View only on mobile — edit this field on desktop.'),
    ).toBeInTheDocument();
  });
});

describe('edit', () => {
  const original = makeAsset({
    fieldValues: { hostname: 'srv-pines-01', mgmt_ip: '10.20.0.5' },
  });

  it('seeds values, disables Save until dirty, and PATCHes the diff with the name attached', async () => {
    route({ detail: original });
    renderForm({ mode: 'edit', assetId: ASSET_ID });

    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const ip = await screen.findByLabelText('Management IP');
    expect(ip).toHaveValue('10.20.0.5');
    fireEvent.change(ip, { target: { value: '10.20.0.6' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await screen.findByText('Asset saved');
    const patch = apiFetch.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH',
    )!;
    expect(JSON.parse(patch[1].body as string)).toEqual({
      // The unchanged name is still attached — omitting it would make
      // the server re-derive from the primary field and clobber a
      // desktop-set custom name.
      name: 'srv-pines-01',
      fieldValues: { mgmt_ip: '10.20.0.6' },
    });
    expect(backMock).toHaveBeenCalled();
  });

  it('a malformed edit URL renders not-found instead of an infinite skeleton', () => {
    renderForm({ mode: 'edit', assetId: 'not-a-uuid' });
    // The disabled detail query reports isPending forever — the UUID
    // guard must branch to not-found before the loading branch.
    expect(screen.getByText(/wasn’t found/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('blocks editing an archived asset with the server copy', async () => {
    route({ detail: makeAsset({ archivedAt: '2026-07-01T00:00:00.000Z' }) });
    renderForm({ mode: 'edit', assetId: ASSET_ID });
    expect(
      await screen.findByText('Cannot edit an archived asset — restore it first.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Management IP')).not.toBeInTheDocument();
  });
});

describe('access gate', () => {
  it('bounces non-managers back to the list', async () => {
    accessMock.canWrite = false;
    renderForm();
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ to: '/assets', replace: true }),
    );
  });
});

describe('name field visibility (Phase 4)', () => {
  it('create hides the Name field entirely and omits name from the payload', async () => {
    renderForm();
    await screen.findByLabelText('Hostname *');
    // The derived-name input used to render first and read as "the
    // title field" — create now leaves naming to the server's
    // primary-field derivation.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Hostname *'), {
      target: { value: 'edge-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
    );
    const [, init] = apiFetch.mock.calls.find(
      ([, i]) => (i as { method?: string } | undefined)?.method === 'POST',
    )!;
    expect(JSON.parse((init as { body: string }).body)).not.toHaveProperty('name');
  });

  it('edit keeps the Name field, seeded from the asset (clobber guard intact)', async () => {
    renderForm({ mode: 'edit', assetId: ASSET_ID });
    const nameInput = await screen.findByLabelText('Name');
    expect(nameInput).toHaveValue('srv-pines-01');
  });
});
