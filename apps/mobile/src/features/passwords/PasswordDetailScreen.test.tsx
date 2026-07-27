/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Me } from '../../screens/TabShell';
import { ToastProvider } from '../../components/Toast';
import { PasswordDetailScreen } from './PasswordDetailScreen';
import { makePasswordDetail } from './test-fixtures';
import type { PasswordDetail } from '@weavestream/shared';

const CO = 'c0000000-0000-4000-8000-000000000002';
const PW = 'a0000000-0000-4000-8000-0000000000a1';
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
jest.mock('./copy', () => ({ copySecret: jest.fn() }));
jest.mock('./clipboard-guard', () => ({
  consumeUniversalClipboardNotice: jest.fn(() => false),
}));
// The TOTP hook has its own timing spec; the screen test pins the
// render contract only.
jest.mock('./use-totp', () => ({
  useTotpCode: jest.fn(() => ({
    code: '418902',
    remainingS: 24,
    progress: 0.2,
    failed: false,
  })),
}));
// DetailHeader's back affordance needs a real router; stub it out —
// the screen contract under test is content + actions.
jest.mock('../../components/DetailHeader', () => ({
  DetailHeader: ({ actions }: { actions?: ReactNode }) => (
    <header>
      <span>Passwords</span>
      {actions}
    </header>
  ),
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };
const { useTotpCode } = jest.requireMock('./use-totp') as { useTotpCode: jest.Mock };
const { ApiError } = jest.requireActual('../../lib/api') as typeof import('../../lib/api');

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

function route({
  detail = makePasswordDetail({ id: PW }),
  relations = { asset: [], article: [], password: [] },
  detailError,
}: {
  detail?: PasswordDetail;
  relations?: {
    asset: unknown[];
    article: unknown[];
    password: unknown[];
  };
  detailError?: unknown;
} = {}) {
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path.includes('/relations')) return Promise.resolve({ groups: relations });
    if (path.includes('/password-folders')) return Promise.resolve({ items: [] });
    if (path.includes('/reveal')) return Promise.resolve({ password: 'plain-text-pw' });
    if (path.includes(`/passwords/${PW}`) && init?.method === 'DELETE')
      return Promise.resolve({ ...detail, archivedAt: '2026-07-01T00:00:00.000Z' });
    if (path.includes(`/passwords/${PW}`))
      return detailError ? Promise.reject(detailError) : Promise.resolve(detail);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <PasswordDetailScreen passwordId={PW} />
    </Wrapper>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  me = operatorMe();
  useTotpCode.mockReturnValue({
    code: '418902',
    remainingS: 24,
    progress: 0.2,
    failed: false,
  });
  route();
});

describe('PasswordDetailScreen', () => {
  it('renders masked by default; the eye reveals; no TOTP row without hasTotp', async () => {
    route({ detail: makePasswordDetail({ id: PW, hasTotp: false }) });
    renderDetail();

    expect(await screen.findByText('Router admin')).toBeInTheDocument();
    expect(screen.getByLabelText('Password hidden')).toBeInTheDocument();
    expect(screen.queryByText('One-time code')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal password' }));
    expect(await screen.findByText('plain-text-pw')).toBeInTheDocument();
    expect(screen.getByText(/Hides in \d+s/)).toBeInTheDocument();
  });

  it('renders the TOTP row (grouped code) when hasTotp', async () => {
    route({ detail: makePasswordDetail({ id: PW, hasTotp: true }) });
    renderDetail();
    expect(await screen.findByText('418 902')).toBeInTheDocument();
  });

  it('pre-empts with the reason sheet when requireReasonToView is set', async () => {
    route({ detail: makePasswordDetail({ id: PW, requireReasonToView: true }) });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal password' }));

    expect(
      await screen.findByPlaceholderText('e.g. Customer ticket #1234'),
    ).toBeInTheDocument();
    // No audited reveal was burned on the guaranteed 400.
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/reveal'),
      expect.anything(),
    );
  });

  it('archived: banner + Restore, and no credential rows or header actions', async () => {
    route({
      detail: makePasswordDetail({
        id: PW,
        hasTotp: true,
        archivedAt: '2026-06-01T00:00:00.000Z',
      }),
    });
    renderDetail();

    expect(await screen.findByText('This password is archived.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByText('Password', { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.queryByText('One-time code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive password' })).not.toBeInTheDocument();
  });

  it('hides edit/archive for READONLY viewers', async () => {
    me = operatorMe({ memberships: [{ companyId: CO, role: 'READONLY', expiresAt: null }] });
    renderDetail();
    await screen.findByText('Router admin');
    expect(screen.queryByRole('button', { name: 'Edit password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive password' })).not.toBeInTheDocument();
    // Reveal stays — password.reveal allows READONLY.
    expect(screen.getByRole('button', { name: 'Reveal password' })).toBeInTheDocument();
  });

  it('archive asks for confirmation, then DELETEs and toasts (Phase 4)', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive password' }));

    // Nothing fires from the header tap — the sheet is the commit point.
    expect(
      apiFetch.mock.calls.filter(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(0);
    expect(
      screen.getByRole('dialog', { name: 'Archive password?' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/passwords/${PW}`),
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(await screen.findByText('Password archived')).toBeInTheDocument();
    // The sheet closes on success.
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Archive password?' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('cancelling the confirmation archives nothing', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('dialog', { name: 'Archive password?' }),
    ).not.toBeInTheDocument();
    expect(
      apiFetch.mock.calls.filter(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(0);
  });

  it('rapid confirm taps issue exactly one DELETE', async () => {
    // The server 400s a second archive of the same row, so an unguarded
    // double-tap would toast a failure right after the success.
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive password' }));
    const confirm = screen.getByRole('button', { name: 'Archive' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await screen.findByText('Password archived');
    const deletes = apiFetch.mock.calls.filter(
      ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deletes).toHaveLength(1);
  });

  it('related password, asset, and article rows all navigate', async () => {
    route({
      relations: {
        password: [
          {
            relationId: 'r1',
            kind: 'password',
            id: 'a0000000-0000-4000-8000-0000000000b2',
            title: 'Linked credential',
            subtitle: null,
          },
        ],
        asset: [
          {
            relationId: 'r2',
            kind: 'asset',
            id: 'b0000000-0000-4000-8000-0000000000d4',
            title: 'RTR-PINES-01',
            subtitle: '10.20.0.1',
          },
        ],
        article: [
          {
            relationId: 'r3',
            kind: 'article',
            id: 'a0000000-0000-4000-8000-0000000000c3',
            title: 'Reboot order runbook',
            subtitle: null,
          },
        ],
      },
    });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: /Linked credential/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords/a0000000-0000-4000-8000-0000000000b2',
    });
    // Article rows became navigable in 2b, now that /articles/:id exists.
    fireEvent.click(screen.getByRole('button', { name: /Reboot order runbook/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/articles/a0000000-0000-4000-8000-0000000000c3',
    });
    // Asset rows became navigable in 2c, now that /assets/:id exists.
    fireEvent.click(screen.getByRole('button', { name: /RTR-PINES-01/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/assets/b0000000-0000-4000-8000-0000000000d4',
    });
  });

  it('show-more carries the danger dot for an expired credential', async () => {
    route({
      detail: makePasswordDetail({ id: PW, expiresAt: '2026-01-01T00:00:00.000Z' }),
    });
    renderDetail();
    await screen.findByText('Router admin');
    expect(screen.getByText(/needs review/i)).toBeInTheDocument();
  });

  it('an unsafe URL renders copy-only — no anchor for javascript:', async () => {
    // The scheme is the rejected input under test.
    route({
      detail: makePasswordDetail({ id: PW, url: 'javascript:alert(1)' }),
    });
    renderDetail();
    await screen.findByText('Router admin');
    expect(screen.queryByRole('link', { name: 'Open URL' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
  });

  it('a scheme-less URL opens as https', async () => {
    route({ detail: makePasswordDetail({ id: PW, url: 'portal.example.com' }) });
    renderDetail();
    const link = await screen.findByRole('link', { name: 'Open URL' });
    expect(link).toHaveAttribute('href', 'https://portal.example.com/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the not-found state for a 404 (covers CLIENT_USER restriction too)', async () => {
    route({ detailError: new ApiError(404, null) });
    renderDetail();
    expect(
      await screen.findByText(/wasn’t found/i),
    ).toBeInTheDocument();
  });

  it('renders the allow-list copy for a restricted 403', async () => {
    route({ detailError: new ApiError(403, { detail: 'not on allow-list' }) });
    renderDetail();
    expect(
      await screen.findByText('You don’t have access to this credential.'),
    ).toBeInTheDocument();
  });
});
