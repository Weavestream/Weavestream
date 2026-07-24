/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { TimezoneProvider } from '../../lib/timezone-context';
import { ProvenanceBadge, provenanceAttention } from './provenance-badge';

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

  it.each([
    ['UTC', 'Jul 10, 2026, 12:00 AM'],
    ['America/New_York', 'Jul 9, 2026, 08:00 PM'],
  ])('renders timestamps in the viewer timezone (%s), not the ambient one', (tz, expected) => {
    render(
      <TimezoneProvider timezone={tz}>
        <ProvenanceBadge provenance={{
          integrationId: crypto.randomUUID(), integrationName: 'Breeze',
          integrationCompanyMappingId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
          sourceLabel: 'Breeze', sourceResource: 'devices', ownership: 'breeze', state: 'active',
          firstSeenAt: '2026-07-10T00:00:00.000Z', lastSeenAt: '2026-07-10T00:00:00.000Z',
          lastSyncedAt: null, staleSince: null,
          target: { targetKind: 'asset', targetId: crypto.randomUUID(), targetLabel: 'HV-01', targetHref: null },
        } as never} />
      </TimezoneProvider>,
    );
    expect(screen.getAllByText(expected)).toHaveLength(2);
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});

describe('provenanceAttention', () => {
  const rec = (state: 'active' | 'stale' | 'blocked') => ({ state }) as never;

  it('maps blocked over stale over all-active', () => {
    expect(provenanceAttention([])).toBeUndefined();
    expect(provenanceAttention([rec('active')])).toBeUndefined();
    expect(provenanceAttention([rec('active'), rec('stale')])).toBe('warn');
    expect(provenanceAttention([rec('stale'), rec('blocked')])).toBe('danger');
  });
});
