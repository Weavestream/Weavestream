/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PasswordVersionSummary } from '@weavestream/shared';
import { VersionHistoryPanel } from './version-history-panel';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const refresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh, replace: jest.fn() }),
}));
jest.mock('../../../../../../../lib/api', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
jest.mock('../../../../../../../lib/timezone-context', () => ({
  FormattedShortDateTime: ({ value }: { value: string }) => <span>{value}</span>,
}));
jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../../../../../components/ui', () => ({
  Btn: ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...p}>{children}</button>
  ),
  Icon: { copy: () => <span /> },
  Panel: ({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) => (
    <section aria-label={title}>
      {actions}
      {children}
    </section>
  ),
  useToast: () => toast,
}));

function v(over: Partial<PasswordVersionSummary> & { version: number }): PasswordVersionSummary {
  return {
    changedFields: [],
    changedBy: '11111111-1111-4111-8111-111111111111',
    changedByName: 'Op',
    changeReason: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

const CURRENT = { name: 'Acme VPN (new)', username: 'new@example.com', url: 'https://new.example' };

function renderPanel(
  versions: PasswordVersionSummary[],
  canManage = true,
  current: { name: string; username: string | null; url: string | null } = CURRENT,
) {
  return render(
    <VersionHistoryPanel
      companyId="co-1"
      passwordId="pw-1"
      versions={versions}
      current={current}
      canManage={canManage}
      requiresReason={false}
      expanded
      onToggleExpanded={jest.fn()}
    />,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  toast.push.mockReset();
  refresh.mockReset();
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('VersionHistoryPanel captured fields', () => {
  const versions = [
    v({
      version: 2,
      changedFields: ['username'],
      name: 'Acme VPN',
      username: 'old@example.com',
      url: null,
    }),
  ];

  it('shows the captured values and marks only the changed ones', () => {
    renderPanel(versions);
    expect(screen.getByText('old@example.com')).toBeInTheDocument();
    expect(screen.getByText('Acme VPN')).toBeInTheDocument();
    expect(screen.getByText('(empty)')).toBeInTheDocument();
    const rows = Array.from(document.querySelectorAll('[data-changed]'));
    expect(rows.map((r) => r.getAttribute('data-changed'))).toEqual(['false', 'true', 'false']);
    expect(screen.getAllByText('changed')).toHaveLength(1);
  });

  it('renders nothing extra for an older payload without values', () => {
    renderPanel([v({ version: 1, changedFields: ['password'] })]);
    expect(document.querySelector('[data-changed]')).toBeNull();
    expect(screen.queryByText(/Restore this/)).not.toBeInTheDocument();
  });

  it('offers a field restore only when the value differs from the current one', () => {
    renderPanel(versions, true, { name: 'Acme VPN', username: 'new@example.com', url: '' });
    expect(screen.getByRole('button', { name: 'Restore this username' })).toBeInTheDocument();
    // Same name; and an empty URL equals the captured null.
    expect(screen.queryByRole('button', { name: 'Restore this name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore this URL' })).not.toBeInTheDocument();
  });

  it('hides the per-field restore without manage permission', () => {
    renderPanel(versions, false);
    expect(screen.getByText('old@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Restore this username')).not.toBeInTheDocument();
  });
});

describe('VersionHistoryPanel restore', () => {
  const versions = [
    v({ version: 2, changedFields: ['username'], name: 'Acme', username: 'old@example.com', url: 'https://a.example' }),
  ];

  it('per-field restore confirms, then posts only that field', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    renderPanel(versions);
    fireEvent.click(screen.getByRole('button', { name: 'Restore this username' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('forward-only'));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('every other field keeps its current value'),
    );
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/companies/co-1/passwords/pw-1/versions/2/restore',
        { method: 'POST', body: JSON.stringify({ fields: ['username'] }) },
      ),
    );
    await waitFor(() => expect(toast.push).toHaveBeenCalledWith('Restored username from v2', 'ok'));
    expect(refresh).toHaveBeenCalled();
  });

  it('per-field restore of the URL uses the url field name', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    renderPanel(versions);
    fireEvent.click(screen.getByRole('button', { name: 'Restore this URL' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/versions/2/restore'),
        { method: 'POST', body: JSON.stringify({ fields: ['url'] }) },
      ),
    );
  });

  it('declining the confirm sends nothing', () => {
    (window.confirm as jest.Mock).mockReturnValue(false);
    renderPanel(versions);
    fireEvent.click(screen.getByRole('button', { name: 'Restore this username' }));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('keeps the whole-version restore with no body', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    renderPanel(versions);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/companies/co-1/passwords/pw-1/versions/2/restore',
        { method: 'POST' },
      ),
    );
    expect(toast.push).toHaveBeenCalledWith('Restored from v2', 'ok');
  });

  it('shows the server problem and does not refresh when restore fails', async () => {
    apiFetch.mockResolvedValue({ ok: false, problem: { detail: 'Cannot restore on archived' } });
    renderPanel(versions);
    fireEvent.click(screen.getByRole('button', { name: 'Restore this username' }));
    await waitFor(() => expect(toast.push).toHaveBeenCalledWith(expect.any(String), 'danger'));
    expect(refresh).not.toHaveBeenCalled();
  });
});
