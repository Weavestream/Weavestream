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
