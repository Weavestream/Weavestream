/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Me } from '../../screens/TabShell';
import { ToastProvider } from '../../components/Toast';
import { PasswordsListScreen } from './PasswordsListScreen';
import { makePasswordSummary } from './test-fixtures';

const CO = 'c0000000-0000-4000-8000-000000000002'; // fixtures' companyId
const navigateMock = jest.fn();
let me: Me;

jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({
    currentOrg: {
      id: 'c0000000-0000-4000-8000-000000000002',
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
  useMe: () => me,
}));
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
jest.mock('../../lib/use-online', () => ({ useOnline: () => true }));
jest.mock('../../lib/navigate', () => ({ redirectToLogin: jest.fn() }));
jest.mock('./copy', () => ({ copySecret: jest.fn() }));
jest.mock('./clipboard-guard', () => ({
  consumeUniversalClipboardNotice: jest.fn(() => false),
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };
const { copySecret } = jest.requireMock('./copy') as { copySecret: jest.Mock };
const { redirectToLogin } = jest.requireMock('../../lib/navigate') as {
  redirectToLogin: jest.Mock;
};

function operatorMe(over: Partial<Me> = {}): Me {
  return {
    id: 'u1',
    email: 'tech@example.com',
    role: 'OPERATOR',
    globalAccess: 'NONE',
    platformCapabilities: [],
    memberships: [{ companyId: CO, role: 'FULL', expiresAt: null }],
    ...over,
  };
}

const rows = [
  makePasswordSummary({ id: 'a0000000-0000-4000-8000-0000000000a1', name: 'Router admin', username: 'admin' }),
  makePasswordSummary({
    id: 'a0000000-0000-4000-8000-0000000000a2',
    name: 'Firewall',
    username: null,
    folderId: 'f0000000-0000-4000-8000-0000000000f1',
  }),
  makePasswordSummary({
    id: 'a0000000-0000-4000-8000-0000000000a3',
    name: 'Breached box',
    username: 'ops',
    pwnedCount: 12,
  }),
];

const folders = [
  {
    id: 'f0000000-0000-4000-8000-0000000000f1',
    companyId: CO,
    parentId: null,
    name: 'Network gear',
    icon: null,
    color: null,
    position: 0,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function route({
  active = rows,
  archived = [] as ReturnType<typeof makePasswordSummary>[],
} = {}) {
  apiFetch.mockImplementation((path: string) => {
    if (path.includes('/password-folders')) return Promise.resolve({ items: folders });
    if (path.includes('archived=true'))
      return Promise.resolve({ items: [...active, ...archived] });
    if (path.includes('/reveal')) return Promise.resolve({ password: 'x' });
    if (path.includes('/passwords')) return Promise.resolve({ items: active });
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderList(filter: { folder?: string; view?: 'attention' | 'archived' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <PasswordsListScreen filter={filter} />
    </Wrapper>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  me = operatorMe();
  route();
});

describe('PasswordsListScreen', () => {
  it('renders rows with the em-dash placeholder for a null username', async () => {
    renderList();
    expect(await screen.findByText('Router admin')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument(); // Firewall's username
  });

  it('chip taps rewrite the search params (replace), not local state', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Network gear' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords',
      replace: true,
      search: { folder: 'f0000000-0000-4000-8000-0000000000f1' },
    });
  });

  it('folder filter shows only that folder’s rows', async () => {
    renderList({ folder: 'f0000000-0000-4000-8000-0000000000f1' });
    expect(await screen.findByText('Firewall')).toBeInTheDocument();
    expect(screen.queryByText('Router admin')).not.toBeInTheDocument();
  });

  it('attention chip carries the bare count (2b: number, no word)', async () => {
    renderList();
    // One pwned row → "1" on the danger chip.
    expect(
      await screen.findByRole('button', { name: 'Needs attention: 1' }),
    ).toBeInTheDocument();
  });

  it('attention view shows only flagged rows', async () => {
    renderList({ view: 'attention' });
    expect(await screen.findByText('Breached box')).toBeInTheDocument();
    expect(screen.queryByText('Router admin')).not.toBeInTheDocument();
  });

  it('archived view fetches archived=true, shows the pill, and offers no copy', async () => {
    const archivedRow = makePasswordSummary({
      id: 'a0000000-0000-4000-8000-0000000000a9',
      name: 'Old switch',
      archivedAt: '2026-06-01T00:00:00.000Z',
    });
    route({ archived: [archivedRow] });
    renderList({ view: 'archived' });

    expect(await screen.findByText('Old switch')).toBeInTheDocument();
    expect(screen.getByText('Archived', { selector: 'span' })).toBeInTheDocument();
    // Active rows are filtered out of the archive view…
    expect(screen.queryByText('Router admin')).not.toBeInTheDocument();
    // …and archived rows have no copy affordance (reveal is blocked anyway).
    expect(screen.queryByRole('button', { name: /copy password/i })).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('archived=true'));
  });

  it('hides New for READONLY access', async () => {
    me = operatorMe({ memberships: [{ companyId: CO, role: 'READONLY', expiresAt: null }] });
    renderList();
    await screen.findByText('Router admin');
    expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument();
  });

  it('hides New for a CLIENT_USER even with a FULL membership', async () => {
    // A client-created record could never be read back (visibleToClients
    // defaults false; client reads require true) — so no write UI.
    me = operatorMe({ role: 'CLIENT_USER' });
    renderList();
    await screen.findByText('Router admin');
    expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument();
  });

  it('shows New for FULL access and routes to the create form', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords/new',
      upIsBack: true,
    });
  });

  it('row copy invokes the executor and does NOT navigate', async () => {
    copySecret.mockResolvedValue({ ok: true });
    renderList();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Copy password for Router admin' }),
    );
    expect(copySecret).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Password copied')).toBeInTheDocument();
  });

  it('a 401 during row copy routes to login, not a "couldn’t copy" toast', async () => {
    // Imperative reveal — the query-cache 401 handler never sees it,
    // and a dead session must not masquerade as a clipboard failure.
    const { ApiError } = jest.requireActual('../../lib/api') as typeof import('../../lib/api');
    copySecret.mockResolvedValue({ ok: false, error: new ApiError(401, null) });
    renderList();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Copy password for Router admin' }),
    );
    await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Couldn’t copy password.')).not.toBeInTheDocument();
  });

  it('row tap navigates to the detail push, stamped as a direct parent push', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: /^Router admin/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords/a0000000-0000-4000-8000-0000000000a1',
      // The stamp is what lets the detail's "‹ Passwords" pop history
      // instead of guessing (see use-back.ts).
      upIsBack: true,
    });
  });

  it('reason-required rows prompt BEFORE revealing, then copy with the reason', async () => {
    const flagged = makePasswordSummary({
      id: 'a0000000-0000-4000-8000-0000000000b1',
      name: 'Guarded',
      requireReasonToView: true,
    });
    route({ active: [flagged] });
    copySecret.mockImplementation(
      ({ fetch }: { fetch: () => Promise<string> }) =>
        fetch().then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        ),
    );
    renderList();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Copy password for Guarded' }),
    );
    // Sheet first — no reveal request was burned.
    expect(copySecret).not.toHaveBeenCalled();
    const reasonInput = await screen.findByPlaceholderText('e.g. Customer ticket #1234');

    fireEvent.change(reasonInput, { target: { value: 'ticket #9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy password' }));

    await waitFor(() => expect(copySecret).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/reveal'),
        expect.objectContaining({ body: JSON.stringify({ reason: 'ticket #9' }) }),
      ),
    );
  });
});
