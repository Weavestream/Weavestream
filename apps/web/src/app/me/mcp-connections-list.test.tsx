/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { McpConnectionsList } from './mcp-connections-list';

const apiFetch = jest.fn();
const refresh = jest.fn();
jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const CONN = {
  id: 'c-1',
  clientId: 'https://claude.ai/oauth/mcp-client-metadata',
  clientVerified: true,
  clientHost: 'claude.ai',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  allowWrite: true,
  lastUsedAt: null,
  expiresAt: '2027-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
};

// An app that registered itself (dynamic client registration).
const DCR_CONN = {
  ...CONN,
  id: 'c-2',
  clientId: 'Xk3_registered',
  clientVerified: false,
  clientHost: null,
  clientName: 'Local agent',
  redirectHost: '127.0.0.1',
};

function renderList(props: Partial<Parameters<typeof McpConnectionsList>[0]> = {}) {
  render(
    <ToastProvider>
      <McpConnectionsList connections={[CONN]} {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  refresh.mockReset();
});

describe('McpConnectionsList', () => {
  it('lists the app with its verified host and access', () => {
    renderList();
    expect(screen.getAllByText('Claude').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude.ai').length).toBeGreaterThan(0);
    expect(screen.getAllByText('can change').length).toBeGreaterThan(0);
  });

  it('revokes through the self-service route after confirming', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204, data: null });
    renderList();
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke Claude connection' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Revoke AI connection' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    });
    expect(apiFetch).toHaveBeenCalledWith('/me/mcp-connections/c-1', { method: 'DELETE' });
    expect(refresh).toHaveBeenCalled();
  });

  it('says when the list failed to load, rather than showing it empty', () => {
    renderList({ connections: [], loadFailed: true });
    expect(screen.getByText('Could not load your AI connections.')).toBeInTheDocument();
    expect(screen.queryByText('No AI connections.')).not.toBeInTheDocument();
  });

  it('says when remote connections are switched off', () => {
    renderList({ enabled: false });
    expect(screen.getByText(/Remote AI connections are turned off/)).toBeInTheDocument();
  });

  it('marks an app that registered itself as Not verified, with no host', () => {
    renderList({ connections: [CONN, DCR_CONN] });
    expect(screen.getAllByText('Local agent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not verified').length).toBeGreaterThan(0);
    expect(screen.queryByText('Xk3_registered')).not.toBeInTheDocument();
  });

  it('does not mark a verified app', () => {
    renderList();
    expect(screen.queryByText('Not verified')).not.toBeInTheDocument();
  });

  it('shows which apps can connect, read-only', () => {
    renderList({ policy: 'claude_chatgpt' });
    expect(screen.getByText('Claude and ChatGPT only')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
