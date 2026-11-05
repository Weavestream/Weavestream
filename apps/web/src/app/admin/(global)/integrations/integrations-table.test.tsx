/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { IntegrationsTable } from './integrations-table';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));
jest.mock('../../../../lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));

const row = (id: string, name: string, hasSecret: boolean, credentialsRequired: boolean) =>
  ({
    id, driver: 'custom-api', name, status: 'PAUSED', config: {}, syncCron: null, effectiveSyncCron: null,
    hasSecret, credentialsRequired, secretMask: null, resources: [], lastRunAt: null, lastRunStatus: null,
    createdBy: null, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', mappingCount: 0,
  }) as never;

describe('IntegrationsTable credentials column', () => {
  it('shows configured, not needed and missing', () => {
    render(
      <IntegrationsTable
        rows={[row('a', 'With key', true, true), row('b', 'Open API', false, false), row('c', 'No key', false, true)]}
        drivers={[{ key: 'custom-api', label: 'Custom API', capabilities: { kind: 'pull' } } as never]}
      />,
    );
    expect(within(screen.getByText('With key').closest('tr')!).getByText('configured')).toBeInTheDocument();
    expect(within(screen.getByText('Open API').closest('tr')!).getByText('not needed')).toBeInTheDocument();
    expect(within(screen.getByText('No key').closest('tr')!).getByText('missing')).toBeInTheDocument();
  });
});
