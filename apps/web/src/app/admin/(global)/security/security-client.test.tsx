/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { ConnectionDiagnostics } from '../../../../lib/server-api';
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
