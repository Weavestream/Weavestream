/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Me } from '../../screens/TabShell';
import { ToastProvider } from '../../components/Toast';
import { PasswordFormScreen } from './PasswordFormScreen';
import { makePasswordDetail } from './test-fixtures';

const CO = 'c0000000-0000-4000-8000-000000000002';
const PW = 'a0000000-0000-4000-8000-0000000000a1';
const navigateMock = jest.fn();
const backMock = jest.fn();
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
jest.mock('../../lib/use-back', () => ({ useBackOr: () => backMock }));
jest.mock('../../lib/use-online', () => ({ useOnline: () => true }));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

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

function renderForm(mode: 'create' | 'edit') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      {mode === 'create' ? (
        <PasswordFormScreen mode="create" />
      ) : (
        <PasswordFormScreen mode="edit" passwordId={PW} />
      )}
    </Wrapper>,
  );
}

const detail = makePasswordDetail({
  id: PW,
  name: 'Router admin',
  username: 'admin',
  url: 'https://r.example',
  notes: 'port 8443',
  hasTotp: true,
});

beforeEach(() => {
  jest.clearAllMocks();
  me = operatorMe();
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    if (path === '/settings') return Promise.resolve({});
    if (init?.method === 'POST' && path.endsWith('/passwords'))
      return Promise.resolve(makePasswordDetail({ id: 'new-id' }));
    if (init?.method === 'PATCH') return Promise.resolve(detail);
    if (path.includes(`/passwords/${PW}`)) return Promise.resolve(detail);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
});

describe('PasswordFormScreen — create', () => {
  it('gates Save on name + password, then POSTs only the filled fields', async () => {
    renderForm('create');
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New cred' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/companies/${CO}/passwords`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'New cred', password: 'hunter2' }),
        }),
      ),
    );
    // Replace-nav to the new detail, so back skips the form.
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords/new-id',
      replace: true,
    });
    expect(await screen.findByText('Password created')).toBeInTheDocument();
  });

  it('rejects a malformed TOTP secret: Save disables, blur explains, no request', async () => {
    renderForm('create');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'y' } });
    const secret = screen.getByLabelText('One-time code secret');
    fireEvent.change(secret, { target: { value: 'not base32!' } });

    // Invalid secret disables Save outright…
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // …and leaving the field (which tapping Save does) explains why.
    fireEvent.blur(secret);
    expect(await screen.findByRole('alert')).toHaveTextContent(/base32/i);
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/passwords$/),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps an unsafe URL available for correction and blocks the request', async () => {
    renderForm('create');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'y' } });
    const url = screen.getByLabelText('URL');

    fireEvent.change(url, { target: { value: 'javascript:alert(1)' } });
    expect(url).toHaveValue('javascript:alert(1)');
    expect(screen.getByText(/starting with http:\/\//i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/passwords$/),
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.change(url, { target: { value: 'https://router.example/admin' } });
    expect(screen.queryByText(/starting with http:\/\//i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows the priming card with the org name', async () => {
    renderForm('create');
    expect(await screen.findByText(/Log it now/)).toBeInTheDocument();
    expect(screen.getByText('Enterprise Title')).toBeInTheDocument();
  });

  it('bounces viewers without write access back to the list', async () => {
    me = operatorMe({ memberships: [{ companyId: CO, role: 'READONLY', expiresAt: null }] });
    renderForm('create');
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ to: '/passwords', replace: true }),
    );
  });
});

describe('PasswordFormScreen — edit', () => {
  it('prefills, keeps Save disabled until something changes, and PATCHes only the diff', async () => {
    renderForm('edit');
    // Wait for the loaded form, not the skeleton chrome (which also
    // renders a disabled Save).
    expect(await screen.findByLabelText('Name')).toHaveValue('Router admin');
    const save = screen.getByRole('button', { name: 'Save' });
    // Untouched form = empty diff = nothing to save.
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'root' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/companies/${CO}/passwords/${PW}`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ username: 'root' }),
        }),
      ),
    );
    expect(await screen.findByText('Password saved')).toBeInTheDocument();
    expect(backMock).toHaveBeenCalled(); // back to detail
  });

  it('a blank password field means keep — the key never enters the PATCH', async () => {
    renderForm('edit');
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = apiFetch.mock.calls.find(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({
        name: 'Renamed',
      });
    });
  });

  it('TOTP tri-state: Remove sends totp:null; Keep sends nothing', async () => {
    renderForm('edit');
    // The existing config renders the segmented control.
    fireEvent.click(await screen.findByRole('button', { name: 'remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = apiFetch.mock.calls.find(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH',
      );
      expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({ totp: null });
    });
  });

  it('surfaces a server rejection inline instead of navigating away', async () => {
    const { ApiError } = jest.requireActual('../../lib/api') as typeof import('../../lib/api');
    apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/settings') return Promise.resolve({});
      if (init?.method === 'PATCH')
        return Promise.reject(new ApiError(400, { detail: 'name must not be empty' }));
      if (path.includes(`/passwords/${PW}`)) return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    renderForm('edit');
    fireEvent.change(await screen.findByLabelText('Username'), {
      target: { value: 'root' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('name must not be empty')).toBeInTheDocument();
    expect(backMock).not.toHaveBeenCalled();
  });
});
