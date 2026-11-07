/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { IntegrationSyncHoldDto } from '@weavestream/shared';
import { SyncHoldsBanner } from './sync-holds-banner';

jest.mock('../../../../../lib/timezone-context', () => ({
  FormattedDateTime: ({ value }: { value: string }) => <time>{value}</time>,
}));

const holds: IntegrationSyncHoldDto[] = [
  {
    kind: 'removal', resourceKey: 'devices', resourceLabel: 'Devices',
    companyId: '00000000-0000-4000-8000-000000000009', companyName: 'Acme',
    since: '2026-11-01T00:00:00.000Z', detail: '4 of 10 records missing from two full syncs',
  },
  {
    kind: 'field', resourceKey: 'device-inventory', resourceLabel: 'Device inventory',
    companyId: '00000000-0000-4000-8000-000000000009', companyName: null,
    since: null, detail: 'device:addresses[].assignment',
  },
];

describe('SyncHoldsBanner', () => {
  it('renders nothing without holds', () => {
    const { container } = render(<SyncHoldsBanner holds={[]} sourceLabel="Breeze RMM" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each hold with its resource, company, kind, detail, and since', () => {
    render(<SyncHoldsBanner holds={holds} sourceLabel="Breeze RMM" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Sync is on hold: Breeze RMM changed/);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Devices');
    expect(items[0]).toHaveTextContent('Acme');
    expect(items[0]).toHaveTextContent('Records missing: 4 of 10 records missing from two full syncs');
    expect(items[0]).toHaveTextContent('since 2026-11-01T00:00:00.000Z');
    expect(items[1]).toHaveTextContent('Field no longer sent: device:addresses[].assignment');
    expect(items[1]).toHaveTextContent('Unknown company');
    expect(items[1]).not.toHaveTextContent('since');
    expect(screen.getByText(/Accept changes from Breeze RMM/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent(/paused resource/);
  });

  it('labels a source version hold and says the paused resource reads nothing', () => {
    render(<SyncHoldsBanner holds={[{
      kind: 'version', resourceKey: 'devices,sites', resourceLabel: '2 resources',
      companyId: '00000000-0000-4000-8000-000000000009', companyName: 'Acme',
      since: '2026-11-02T00:00:00.000Z', detail: 'schema version 2',
    }]} sourceLabel="Breeze RMM" />);
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('2 resources');
    expect(item).toHaveTextContent('Unknown source version: schema version 2');
    expect(screen.getByRole('alert')).toHaveTextContent(/A paused resource reads nothing from Breeze RMM/);
  });
});
