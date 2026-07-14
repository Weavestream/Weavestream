/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { ProvenanceBadge } from './provenance-badge';

describe('ProvenanceBadge', () => {
  it('uses accessible state/ownership/source/date text and never renders raw source values', () => {
    render(<ProvenanceBadge provenance={{
      integrationId: '00000000-0000-4000-8000-000000000001', integrationName: 'Breeze',
      integrationCompanyMappingId: '00000000-0000-4000-8000-000000000002',
      resourceId: '00000000-0000-4000-8000-000000000003', sourceLabel: 'Breeze',
      sourceResource: 'devices', ownership: 'breeze', state: 'stale',
      firstSeenAt: '2026-07-10T00:00:00.000Z', lastSeenAt: '2026-07-13T00:00:00.000Z',
      lastSyncedAt: '2026-07-13T00:01:00.000Z', staleSince: '2026-07-14T00:00:00.000Z',
      target: { targetKind: 'asset', targetId: '00000000-0000-4000-8000-000000000004', targetLabel: 'HV-01', targetHref: null },
      externalId: 'raw-upstream-id-must-not-render', providerUrl: 'https://provider.example/secret',
    } as never} />);
    expect(screen.getByText('Stale source record')).toBeInTheDocument();
    expect(screen.getByText(/Breeze · devices/)).toBeInTheDocument();
    expect(screen.getByText(/Source-owned/)).toBeInTheDocument();
    expect(screen.getByText(/First seen/)).toBeInTheDocument();
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
    expect(screen.getByText(/Last synchronized/)).toBeInTheDocument();
    expect(screen.getByText(/Stale since/)).toBeInTheDocument();
    expect(screen.queryByText(/raw-upstream-id|provider\.example/)).not.toBeInTheDocument();
  });

  it.each([
    ['active', 'Active source record'],
    ['blocked', 'Blocked source record'],
  ] as const)('renders %s state in text, not color alone', (state, label) => {
    render(<ProvenanceBadge provenance={{
      integrationId: crypto.randomUUID(), integrationName: 'Breeze',
      integrationCompanyMappingId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
      sourceLabel: 'Breeze', sourceResource: 'scripts', ownership: 'weavestream', state,
      firstSeenAt: '2026-07-10T00:00:00.000Z', lastSeenAt: '2026-07-13T00:00:00.000Z',
      lastSyncedAt: null, staleSince: null,
      target: { targetKind: 'article', targetId: crypto.randomUUID(), targetLabel: 'Script', targetHref: null },
    }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
