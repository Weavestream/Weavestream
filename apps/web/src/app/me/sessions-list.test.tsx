/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionsList } from './sessions-list';

/**
 * "Revoke other sessions" also revokes every API key the user holds
 * (`MeService.revokeOtherSessions`). Someone tidying up old browser sessions
 * must be told that before it happens, and told afterwards how many keys
 * went, or their scripts and MCP agents stop with no visible cause.
 */

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const refresh = jest.fn();

jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('../../lib/timezone-context', () => ({ FormattedRelative: () => null }));
jest.mock('../../components/ui', () => ({
  Btn: ({
    children,
    loading: _loading,
    kind: _kind,
    size: _size,
    icon: _icon,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  DataTable: () => null,
  Dialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    footer: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        {footer}
      </div>
    ) : null,
  Icon: { shield: () => null },
  MobileCardRow: () => null,
  Tag: () => null,
  useToast: () => toast,
}));

const sessions = [
  { id: 'a', ip: null, userAgent: null, createdAt: '', expiresAt: '', current: true },
  { id: 'b', ip: null, userAgent: null, createdAt: '', expiresAt: '', current: false },
  { id: 'c', ip: null, userAgent: null, createdAt: '', expiresAt: '', current: false },
];

beforeEach(() => jest.clearAllMocks());

describe('SessionsList revoke others', () => {
  it('asks first and names the API key impact', () => {
    render(<SessionsList sessions={sessions} apiKeyCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 other sessions' }));

    expect(apiFetch).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Revoke other sessions' });
    expect(dialog).toHaveTextContent('You have 2 API keys.');
    expect(dialog).toHaveTextContent('permanently revokes every API key');
  });

  it('still warns about keys when the count is unknown', () => {
    render(<SessionsList sessions={sessions} apiKeyCount={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 other sessions' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('permanently revokes every API key');
  });

  it('omits the key warning when the user holds none', () => {
    render(<SessionsList sessions={sessions} apiKeyCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 other sessions' }));
    expect(screen.getByRole('dialog')).not.toHaveTextContent('API key');
  });

  it('does nothing on cancel', () => {
    render(<SessionsList sessions={sessions} apiKeyCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 other sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports revoked keys from the server count after confirming', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { revoked: 2, apiKeysRevoked: 3 } });
    render(<SessionsList sessions={sessions} apiKeyCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 other sessions' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke sessions and keys' }));
    });

    expect(apiFetch).toHaveBeenCalledWith('/me/sessions/revoke-others', { method: 'POST' });
    await waitFor(() =>
      expect(toast.push).toHaveBeenCalledWith(
        expect.stringContaining('3 API keys revoked'),
        'ok',
      ),
    );
    expect(refresh).toHaveBeenCalled();
  });
});
