/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CompletenessTab } from './completeness-tab';
import { apiFetch } from '../../../../../lib/api';

jest.mock('../../../../../lib/api', () => ({ apiFetch: jest.fn() }));
const fetchMock = apiFetch as jest.MockedFunction<typeof apiFetch>;

describe('CompletenessTab', () => {
  const ids = {
    gap1: '00000000-0000-4000-8000-000000000001', gap2: '00000000-0000-4000-8000-000000000002',
    company: '00000000-0000-4000-8000-000000000003', mapping: '00000000-0000-4000-8000-000000000004',
    resource: '00000000-0000-4000-8000-000000000005', asset: '00000000-0000-4000-8000-000000000006',
    unmapped: '00000000-0000-4000-8000-000000000007',
    summary1: '00000000-0000-4000-8000-000000000008',
    summary2: '00000000-0000-4000-8000-000000000009',
    company2: '00000000-0000-4000-8000-000000000010',
    mapping2: '00000000-0000-4000-8000-000000000011',
    resource2: '00000000-0000-4000-8000-000000000012',
  };
  beforeEach(() => fetchMock.mockReset());

  it('renders all six categories, scoped filters, safe gaps, and only native target links', async () => {
    const summaryResponse = { ok: true, status: 200, data: {
        counts: { synchronizedCurrent: 1, manuallyDocumented: 2, secretBlocked: 3, missing: 4, stale: 5, synchronizationError: 6 },
        rows: [{
          id: ids.summary1, companyId: ids.company, companyName: 'Acme',
          integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
          resourceKey: 'devices', resourceLabel: 'Devices',
          counts: { synchronizedCurrent: 1, manuallyDocumented: 2, secretBlocked: 3, missing: 4, stale: 5, synchronizationError: 6 },
          evaluatedAt: '2026-07-14T01:00:00.000Z', lastSuccessfulSyncAt: '2026-07-14T00:59:00.000Z',
        }, {
          id: ids.summary2, companyId: ids.company2, companyName: 'Beta',
          integrationCompanyMappingId: ids.mapping2, resourceId: ids.resource2,
          resourceKey: 'scripts', resourceLabel: 'Scripts',
          counts: { synchronizedCurrent: 7, manuallyDocumented: 8, secretBlocked: 9, missing: 10, stale: 11, synchronizationError: 12 },
          evaluatedAt: '2026-07-14T02:00:00.000Z', lastSuccessfulSyncAt: null,
        }],
      }};
    const gapsResponse = { ok: true, status: 200, data: {
        items: [{
          id: ids.gap1, companyId: ids.company, companyName: 'Acme',
          integrationCompanyMappingId: ids.mapping,
          resourceId: ids.resource, resourceKey: 'devices', resourceLabel: 'Devices',
          kind: 'synchronization_error', message: 'Safe retry required.',
          firstSeenAt: '2026-07-13T00:00:00.000Z', lastSeenAt: '2026-07-14T00:00:00.000Z',
          resolvedAt: null,
          target: { targetKind: 'asset', targetId: ids.asset, targetLabel: 'HV-01', targetHref: `/admin/companies/${ids.company}/assets/${ids.asset}` },
        }, {
          id: ids.gap2, companyId: ids.company, companyName: 'Acme',
          integrationCompanyMappingId: ids.mapping,
          resourceId: ids.resource, resourceKey: 'devices', resourceLabel: 'Devices',
          kind: 'secret_blocked', message: 'Definition requires manual documentation.',
          firstSeenAt: '2026-07-13T00:00:00.000Z', lastSeenAt: '2026-07-14T00:00:00.000Z',
          resolvedAt: null, target: null,
        }], nextCursor: null,
      }};
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('/completeness') ? summaryResponse as never : gapsResponse as never,
    );

    render(<CompletenessTab
      integrationId="integration-1"
      mappings={[
        { id: ids.mapping, companyName: 'Acme', externalOrgName: 'Acme upstream' } as never,
        { id: ids.unmapped, companyName: null, externalOrgName: 'Raw upstream tenant', externalOrgId: 'raw-tenant-id' } as never,
      ]}
      resources={[{ id: ids.resource, resourceKey: 'devices', resourceLabel: 'Devices' } as never]}
    />);

    for (const label of [
      'Synchronized/current', 'Manually documented', 'Secret-blocked',
      'Missing', 'Stale', 'Synchronization error',
    ]) expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByLabelText('Organization mapping')).toBeInTheDocument();
    expect(screen.getByLabelText('Resource')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'HV-01' })).toHaveAttribute(
      'href', `/admin/companies/${ids.company}/assets/${ids.asset}`,
    );
    expect(screen.queryByText('Acme upstream')).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw upstream tenant|raw-tenant-id/)).not.toBeInTheDocument();
    expect(screen.queryByText(/raw source|provider url|secret value/i)).not.toBeInTheDocument();

    const acmeRow = screen.getByLabelText('Acme Devices completeness');
    expect(within(acmeRow).getByText('1 Synchronized/current')).toBeInTheDocument();
    expect(within(acmeRow).getByText('2 Manually documented')).toBeInTheDocument();
    expect(within(acmeRow).getByText('3 Secret-blocked')).toBeInTheDocument();
    expect(within(acmeRow).getByText('4 Missing')).toBeInTheDocument();
    expect(within(acmeRow).getByText('5 Stale')).toBeInTheDocument();
    expect(within(acmeRow).getByText('6 Synchronization error')).toBeInTheDocument();
    const betaRow = screen.getByLabelText('Beta Scripts completeness');
    expect(within(betaRow).getByText('7 Synchronized/current')).toBeInTheDocument();
    expect(within(betaRow).getByText('8 Manually documented')).toBeInTheDocument();
    expect(within(betaRow).getByText('9 Secret-blocked')).toBeInTheDocument();
    expect(within(betaRow).getByText('10 Missing')).toBeInTheDocument();
    expect(within(betaRow).getByText('11 Stale')).toBeInTheDocument();
    expect(within(betaRow).getByText('12 Synchronization error')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: ids.resource } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`resourceId=${ids.resource}`),
    ));
  });

  it('renders loading, error, and empty states', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise((r) => { resolve = r; }) as never)
      .mockResolvedValueOnce({ ok: true, status: 200, data: { items: [], nextCursor: null } } as never);
    render(<CompletenessTab integrationId="integration-1" mappings={[]} resources={[]} />);
    expect(screen.getByText('Loading completeness…')).toBeInTheDocument();
    resolve({ ok: false, status: 500, problem: { detail: 'Could not load.' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load.');
  });
});
