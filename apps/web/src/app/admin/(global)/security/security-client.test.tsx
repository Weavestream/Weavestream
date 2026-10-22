/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../../../components/ui';
import type { ConnectionDiagnostics } from '@weavestream/shared';
import { SecurityCenterClient } from './security-client';

const apiFetch = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('../../../../lib/api', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

function diagnostics(overrides: Partial<ConnectionDiagnostics> = {}): ConnectionDiagnostics {
  return {
    resolvedIp: '198.51.100.7',
    socketPeer: '172.18.0.5',
    peerTrusted: true,
    forwardedForReceived: '198.51.100.7',
    inboundForwardedFor: '198.51.100.7, 172.18.0.4',
    trustProxyHops: 2,
    webTrustProxyHops: 2,
    interpretation: ['Only the single sanitized resolvedIp is used downstream.'],
    ...overrides,
  };
}

// The Connection pane fetches whoami itself, in the browser, so the
// whole client is rendered on that tab rather than the pane alone.
function renderConnectionTab(data: ConnectionDiagnostics) {
  apiFetch.mockResolvedValue({ ok: true, status: 200, data });
  render(
    <SecurityCenterClient
      initialTab="diagnostics"
      initialWindow={24}
      activity={null}
      lockouts={null}
      blocks={null}
      sessions={null}
      egress={null}
      apiKeys={null}
      apiKeysEnabled={false}
      connections={null}
      mcpRemoteEnabled={false}
      mcpClientPolicy="claude_chatgpt"
      canRevoke={false}
      currentUserId="u-1"
    />,
  );
}

// DiagRow renders the label and the value as siblings in one card.
async function hopsRow(): Promise<HTMLElement> {
  const label = await screen.findByText('TRUST_PROXY_HOPS');
  return label.parentElement as HTMLElement;
}

describe('SecurityCenterClient — Connection tab', () => {
  beforeEach(() => apiFetch.mockReset());

  it('shows the web tier hop count next to the API value and flags a mismatch', async () => {
    renderConnectionTab(diagnostics({ webTrustProxyHops: 2, trustProxyHops: 1 }));
    const row = await hopsRow();
    expect(apiFetch).toHaveBeenCalledWith('/security/whoami');
    expect(row).toHaveTextContent(/web \(applied\)\s*2/);
    expect(row).toHaveTextContent(/API \(config\)\s*1/);
    expect(row).toHaveTextContent('mismatch');
  });

  it('shows no mismatch tag when both tiers agree', async () => {
    renderConnectionTab(diagnostics());
    const row = await hopsRow();
    expect(row).toHaveTextContent(/web \(applied\)\s*2/);
    expect(row).toHaveTextContent(/API \(config\)\s*2/);
    expect(row).not.toHaveTextContent('mismatch');
  });

  it('shows a dash and no mismatch when the web tier did not report a value', async () => {
    renderConnectionTab(diagnostics({ webTrustProxyHops: null, trustProxyHops: 1 }));
    const row = await hopsRow();
    expect(row).toHaveTextContent(/web \(applied\)\s*—/);
    expect(row).not.toHaveTextContent('mismatch');
  });

  it('labels the inbound chain as what the web tier received', async () => {
    renderConnectionTab(diagnostics());
    const label = await screen.findByText('Inbound chain (as received by web)');
    expect(label.parentElement).toHaveTextContent('198.51.100.7, 172.18.0.4');
  });
});

describe('API keys tab', () => {
  const KEY = {
    id: 'k-1',
    keyId: '0123456789abcdef01',
    name: 'MCP on laptop',
    scopes: [],
    allowPasswordReveal: false,
    allowWrite: true,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    user: { id: 'u-9', name: 'Pat Doe', email: 'pat@example.com' },
  };

  function renderKeys(
    props: { enabled?: boolean; canRevoke?: boolean; total?: number; page?: number } = {},
  ) {
    render(
      <ToastProvider>
        <SecurityCenterClient
          initialTab="api-keys"
          initialWindow={24}
          activity={null}
          lockouts={null}
          blocks={null}
          sessions={null}
          egress={null}
          apiKeys={{
            items: [KEY],
            total: props.total ?? 1,
            page: props.page ?? 1,
            pageSize: 50,
          }}
          apiKeysEnabled={props.enabled ?? true}
          connections={null}
          mcpRemoteEnabled={false}
          mcpClientPolicy="claude_chatgpt"
          canRevoke={props.canRevoke ?? true}
          currentUserId="u-1"
        />
      </ToastProvider>,
    );
  }

  beforeEach(() => {
    apiFetch.mockReset();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('shows every key with its owner and what it may do', () => {
    renderKeys();
    expect(screen.getAllByText('MCP on laptop').length).toBeGreaterThan(0);
    expect(screen.getAllByText('pat@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('can change').length).toBeGreaterThan(0);
  });

  it('revokes through the admin route after confirmation', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { revoked: 1 } });
    renderKeys();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith('/security/api-keys/k-1', { method: 'DELETE' });
  });

  it('hides revoke from admins without user.manage', () => {
    renderKeys({ canRevoke: false });
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('pages instead of hiding keys beyond the first page', () => {
    renderKeys({ total: 120, page: 2 });
    expect(screen.getByText(/120/)).toBeInTheDocument();
    const page3 = screen.getByRole('link', { name: 'Page 3' });
    expect(page3.getAttribute('href')).toContain('keyPage=3');
    expect(page3.getAttribute('href')).toContain('tab=api-keys');
  });

  it('says when keys are switched off instance-wide', () => {
    renderKeys({ enabled: false });
    expect(screen.getByText(/API keys are turned off/)).toBeInTheDocument();
  });
});

describe('SecurityCenterClient — AI connections tab', () => {
  const CONN = {
    id: 'c-1',
    clientId: 'https://chatgpt.com/oauth/client.json',
    clientVerified: true,
    clientHost: 'chatgpt.com',
    clientName: 'ChatGPT',
    redirectHost: 'chatgpt.com',
    allowWrite: false,
    lastUsedAt: null,
    expiresAt: '2027-10-01T00:00:00Z',
    createdAt: '2026-10-01T00:00:00Z',
    user: { id: 'u-9', name: 'Pat Doe', email: 'pat@example.com' },
  };
  // An app that registered itself: no checked host.
  const DCR_CONN = { ...CONN, id: 'c-2', clientId: 'Xk3_registered', clientVerified: false, clientHost: null, clientName: 'Local agent', redirectHost: '127.0.0.1' };

  function renderConnections(
    props: {
      enabled?: boolean;
      canRevoke?: boolean;
      total?: number;
      page?: number;
      items?: (typeof CONN | typeof DCR_CONN)[];
      policy?: 'claude_chatgpt' | 'any';
    } = {},
  ) {
    render(
      <ToastProvider>
        <SecurityCenterClient
          initialTab="ai-connections"
          initialWindow={24}
          activity={null}
          lockouts={null}
          blocks={null}
          sessions={null}
          egress={null}
          apiKeys={null}
          apiKeysEnabled
          connections={{ items: props.items ?? [CONN], total: props.total ?? 1, page: props.page ?? 1, pageSize: 50 }}
          mcpRemoteEnabled={props.enabled ?? true}
          mcpClientPolicy={props.policy ?? 'claude_chatgpt'}
          canRevoke={props.canRevoke ?? true}
          currentUserId="u-1"
        />
      </ToastProvider>,
    );
  }

  beforeEach(() => {
    apiFetch.mockReset();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('shows every connection with its owner, app host and access', () => {
    renderConnections();
    expect(screen.getAllByText('ChatGPT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('chatgpt.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('pat@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('read-only').length).toBeGreaterThan(0);
  });

  it('revokes through the admin route after confirmation', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { revoked: 1 } });
    renderConnections();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith('/security/mcp-connections/c-1', { method: 'DELETE' });
  });

  it('a network failure clears the busy state and says nothing was revoked', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    renderConnections();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    });
    expect(screen.getByText(/could not be reached. The connection was not revoked/)).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: 'Revoke' })) expect(b).toBeEnabled();
  });

  it('hides revoke from admins without user.manage', () => {
    renderConnections({ canRevoke: false });
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('pages with its own parameter', () => {
    renderConnections({ total: 120, page: 2 });
    const page3 = screen.getByRole('link', { name: 'Page 3' });
    expect(page3.getAttribute('href')).toContain('connPage=3');
    expect(page3.getAttribute('href')).toContain('tab=ai-connections');
  });

  it('says when remote connections are switched off instance-wide', () => {
    renderConnections({ enabled: false });
    expect(screen.getByText(/Remote AI connections are turned off/)).toBeInTheDocument();
  });

  it('shows which apps can connect, read-only', () => {
    renderConnections({ policy: 'any' });
    expect(screen.getByText('Any MCP app')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('marks an app that registered itself as Not verified, in place of a host', () => {
    renderConnections({ items: [CONN, DCR_CONN], total: 2, policy: 'any' });
    expect(screen.getAllByText('Local agent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not verified').length).toBeGreaterThan(0);
    // The verified one keeps its host and no mark of its own.
    expect(screen.getAllByText('chatgpt.com').length).toBeGreaterThan(0);
  });
});
