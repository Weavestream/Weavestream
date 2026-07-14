/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunsTab } from './runs-tab';

jest.mock('../../../../../lib/timezone-context', () => ({ FormattedDateTime: ({ value }: { value: string }) => <>{value}</> }));
const apiFetch = jest.fn();
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

it('shows incremental/full mode and reconstruction lifecycle counters without conflict JSON', () => {
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[{
    id: 'run-1', mode: 'full', kind: 'manual', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null,
    totals: { fetched: 10, created: 0, updated: 0, unchanged: 2, claimed: 0, archived: 0,
      skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
      stale: 3, restored: 4, blocked: 5, secretBlocked: 6, missingDependency: 7, errors: 1 },
  }] as never} />);
  expect(screen.getByText('full')).toBeInTheDocument();
  expect(screen.getByText(/3 stale/)).toBeInTheDocument();
  expect(screen.getByText(/4 restored/)).toBeInTheDocument();
  expect(screen.getByText(/5 blocked/)).toBeInTheDocument();
  expect(screen.getByText(/6 secret blocked/)).toBeInTheDocument();
  expect(screen.getByText(/7 missing dependency/)).toBeInTheDocument();
  expect(screen.queryByText(/candidateAssetIds|conflict JSON/)).not.toBeInTheDocument();
});

it('does not render raw external identities in conflict details', async () => {
  const run = {
    id: 'run-1', mode: 'incremental', kind: 'manual', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals: null,
  };
  apiFetch.mockResolvedValueOnce({ ok: true, data: {
    run,
    companyResults: [{
      id: 'result-1', integrationCompanyMappingId: 'mapping-1', companyId: 'company-1',
      companyName: 'Acme', status: 'succeeded', totals: null, error: null,
      conflicts: [{ kind: 'validation_error', externalId: 'raw-upstream-id', message: 'Record requires review.' }],
    }],
  }});
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[run] as never} />);
  fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByText(/Record requires review/)).toBeInTheDocument();
  expect(screen.queryByText(/raw-upstream-id/)).not.toBeInTheDocument();
});
