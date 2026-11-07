/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunsTab } from './runs-tab';

jest.mock('../../../../../lib/timezone-context', () => ({ FormattedDateTime: ({ value }: { value: string }) => <>{value}</> }));
const apiFetch = jest.fn();
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
let mobile = false;
jest.mock('../../../../../lib/hooks/use-is-mobile', () => ({ useIsMobile: () => mobile }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
afterEach(() => { mobile = false; });

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
  fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
  expect(await screen.findByText(/Record requires review/)).toBeInTheDocument();
  expect(screen.queryByText(/raw-upstream-id/)).not.toBeInTheDocument();
});

it('labels a withheld secret as secret blocked rather than a validation error', async () => {
  const run = {
    id: 'run-secret', mode: 'full', kind: 'manual', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals: null,
  };
  apiFetch.mockResolvedValueOnce({ ok: true, data: {
    run,
    companyResults: [{
      id: 'result-1', integrationCompanyMappingId: 'mapping-1', companyId: 'company-1',
      companyName: 'Acme', status: 'succeeded', totals: null, error: null,
      conflicts: [{
        kind: 'secret_blocked', externalId: 'raw-upstream-id',
        message: 'Weavestream withheld scripts record "Backup check" (33333333-3333-4333-8333-333333333333) because the field content looks like it holds a credential.',
      }],
    }],
  }});
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[run] as never} />);
  fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
  expect(await screen.findByText(/Weavestream withheld scripts record "Backup check"/)).toBeInTheDocument();
  expect(screen.getByText('secret blocked')).toBeInTheDocument();
  expect(screen.queryByText('validation error')).not.toBeInTheDocument();
});

it('renders per-resource activity when only reconstruction counters are nonzero', async () => {
  const zeroes = {
    fetched: 0, created: 0, updated: 0, unchanged: 0, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
    stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
  };
  const run = {
    id: 'run-reconstruction', mode: 'full', kind: 'manual', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null,
    totals: {
      ...zeroes,
      byResource: {
        scripts: { ...zeroes, secretBlocked: 2 },
        relations: { ...zeroes, missingDependency: 3 },
      },
    },
  };
  apiFetch.mockResolvedValueOnce({ ok: true, data: { run, companyResults: [] } });
  render(<RunsTab integration={{ id: 'integration-1', resources: [
    { resourceKey: 'scripts', resourceLabel: 'Scripts' },
    { resourceKey: 'relations', resourceLabel: 'Relationships' },
  ] } as never} mappings={[]} runs={[run] as never} />);
  fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
  expect(await screen.findByText('Scripts')).toBeInTheDocument();
  expect(screen.getByText('2 secret blocked')).toBeInTheDocument();
  expect(screen.getByText('Relationships')).toBeInTheDocument();
  expect(screen.getByText('3 missing dependency')).toBeInTheDocument();
});

describe('domains variant (Cloudflare)', () => {
  const base = {
    mode: 'incremental', kind: 'scheduled', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, finishedAt: null,
  };

  it('shows domain sync counts, no mode, and a failed run’s error in the row', () => {
    render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} variant="domains" runs={[
      { ...base, id: 'run-ok', status: 'succeeded', error: null,
        totals: { enabled: true, created: 2, updated: 5, adopted: 1, missing: 0, skipped: 0 } },
      { ...base, id: 'run-bad', status: 'failed', totals: null,
        error: 'Cloudflare refused the token: it lacks Registrar read access.' },
    ] as never} />);
    expect(screen.getByText('2 new, 5 updated, 1 taken over, 0 no longer on the account')).toBeInTheDocument();
    expect(screen.getByText(/lacks Registrar read access/)).toBeInTheDocument();
    expect(screen.queryByText('incremental')).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('opens a run without the per-company section', async () => {
    const run = { ...base, id: 'run-bad', status: 'failed', totals: null, error: 'The sync ran out of time.' };
    apiFetch.mockResolvedValueOnce({ ok: true, data: { run, companyResults: [] } });
    render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} variant="domains" runs={[run] as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
    expect(await screen.findByText('Summary')).toBeInTheDocument();
    expect(screen.getAllByText('The sync ran out of time.')).toHaveLength(2);
    expect(screen.queryByText('Per-company results')).not.toBeInTheDocument();
  });

  it('points an empty history at the Domains tab', () => {
    render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} variant="domains" runs={[]} />);
    expect(screen.getByText(/Sync domains now/)).toBeInTheDocument();
  });
});

it('renders one card per run on a phone, with the full error and the mode', async () => {
  mobile = true;
  const error = 'Cloudflare refused the token: it lacks Registrar read access for this account.';
  const runs = [
    { id: 'run-ok', mode: 'full', kind: 'manual', status: 'succeeded', dryRun: true,
      createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, error: null,
      totals: { fetched: 4, created: 1, updated: 0, unchanged: 3, claimed: 0, archived: 0,
        skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
        stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0 } },
    { id: 'run-bad', mode: 'incremental', kind: 'scheduled', status: 'failed', dryRun: false,
      createdAt: '2026-07-13T00:00:00.000Z', startedAt: null, totals: null, error },
  ];
  apiFetch.mockResolvedValueOnce({ ok: true, data: { run: runs[1], companyResults: [] } });
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={runs as never} />);
  const cards = screen.getAllByRole('listitem');
  expect(cards).toHaveLength(2);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByText('full')).toBeInTheDocument();
  expect(screen.getByText('dry run')).toBeInTheDocument();
  expect(screen.getByText(/4 fetched · 1 created/)).toBeInTheDocument();
  expect(screen.getByText(error)).toBeInTheDocument();
  fireEvent.click(screen.getByText(error));
  expect(await screen.findByText('Run details')).toBeInTheDocument();
});

it('shows a succeeded run with blocked records as warnings, and a clean one as succeeded', () => {
  const zeroes = {
    fetched: 3, created: 0, updated: 0, unchanged: 3, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
    stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
  };
  const runs = [
    { id: 'run-clean', mode: 'full', kind: 'manual', status: 'succeeded', dryRun: false,
      createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals: zeroes },
    { id: 'run-warn', mode: 'full', kind: 'manual', status: 'succeeded', dryRun: false,
      createdAt: '2026-07-13T00:00:00.000Z', startedAt: null,
      totals: { ...zeroes, blocked: 1, secretBlocked: 1 } },
  ];
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={runs as never} />);
  expect(screen.getAllByText('warnings').length).toBeGreaterThan(0);
  expect(screen.getAllByText('succeeded').length).toBeGreaterThan(0);
});

it('shows warnings for a resumed incomplete run whose other counters are zero', () => {
  const totals = {
    fetched: 0, created: 0, updated: 0, unchanged: 0, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
    stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
    incomplete: 1,
  };
  const run = { id: 'run-resumed', mode: 'full', kind: 'scheduled', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals };
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[run] as never} />);
  expect(screen.getAllByText('warnings').length).toBeGreaterThan(0);
  expect(screen.queryByText('succeeded')).not.toBeInTheDocument();
  expect(screen.getAllByText(/1 incomplete/).length).toBeGreaterThan(0);
});

it('shows records a full sync did not see without marking the run as warnings', () => {
  const totals = {
    fetched: 5, created: 0, updated: 0, unchanged: 5, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
    stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
    incomplete: 0, notSeen: 2,
  };
  const run = { id: 'run-missed', mode: 'full', kind: 'scheduled', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals };
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[run] as never} />);
  expect(screen.getAllByText(/2 not seen/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('succeeded').length).toBeGreaterThan(0);
});

it('shows a run with withheld values as warnings and labels the redaction warning', async () => {
  const totals = {
    fetched: 4, created: 4, updated: 0, unchanged: 0, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
    stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
    incomplete: 0, notSeen: 0, redacted: 2, paused: 0,
  };
  const run = { id: 'run-redacted', mode: 'full', kind: 'manual', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals };
  apiFetch.mockResolvedValueOnce({ ok: true, data: {
    run,
    companyResults: [{
      id: 'result-1', integrationCompanyMappingId: 'mapping-1', companyId: 'company-1',
      companyName: 'Acme', status: 'succeeded', totals, error: null,
      conflicts: [{
        kind: 'secret_redacted', externalId: 'org-1:scripts:s1',
        message: 'Weavestream withheld 1 value that looked like credentials (content). The rest of the record was synced.',
      }],
    }],
  }});
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[run] as never} />);
  expect(screen.getAllByText('warnings').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/2 with values withheld/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
  expect(await screen.findByText(/The rest of the record was synced/)).toBeInTheDocument();
  expect(screen.queryByText('secret blocked')).not.toBeInTheDocument();
});

it('shows a run the source paused as paused, not succeeded', () => {
  const totals = {
    fetched: 0, created: 0, updated: 0, unchanged: 0, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
    stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
    incomplete: 0, notSeen: 0, redacted: 0, paused: 1,
  };
  const run = { id: 'run-paused', mode: 'full', kind: 'scheduled', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals };
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[run] as never} />);
  expect(screen.getAllByText('paused').length).toBeGreaterThan(0);
  expect(screen.queryByText('succeeded')).not.toBeInTheDocument();
  expect(screen.getAllByText(/1 paused/).length).toBeGreaterThan(0);
});

describe('source version (early warning)', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    id: 'run-v', mode: 'incremental', kind: 'scheduled', status: 'succeeded', dryRun: false,
    createdAt: '2026-11-07T00:00:00.000Z', startedAt: null, totals: null, error: null,
    sourceServerVersion: '0.126.0', sourceSchemaVersion: '1', sourceVersionChange: null,
    ...overrides,
  });

  it('shows the source release and schema version in the run details', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: { run: run(), companyResults: [] } });
    render(<RunsTab integration={{ id: 'integration-1', name: 'Breeze', resources: [] } as never}
      mappings={[]} runs={[run()] as never} sourceLabel="Breeze RMM" />);
    expect(screen.queryByText('new version')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
    expect(await screen.findByText('source version: 0.126.0')).toBeInTheDocument();
    expect(screen.getByText('API schema version: 1')).toBeInTheDocument();
    expect(screen.queryByText(/version changed from/)).not.toBeInTheDocument();
  });

  it('marks a run whose source release changed and names both versions in the details', async () => {
    const changed = run({ sourceVersionChange: { from: '0.125.0', to: '0.126.0' } });
    apiFetch.mockResolvedValueOnce({ ok: true, data: { run: changed, companyResults: [] } });
    render(<RunsTab integration={{ id: 'integration-1', name: 'Breeze', resources: [] } as never}
      mappings={[]} runs={[changed] as never} sourceLabel="Breeze RMM" />);
    expect(screen.getByText('new version').parentElement).toHaveAttribute(
      'title', 'Breeze RMM version changed from 0.125.0 to 0.126.0 since the previous run.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
    expect(await screen.findByText(
      'Breeze RMM version changed from 0.125.0 to 0.126.0 since the previous run.',
    )).toBeInTheDocument();
  });

  it('shows nothing about versions for a run without them', async () => {
    const plain = run({ sourceServerVersion: null, sourceSchemaVersion: null });
    apiFetch.mockResolvedValueOnce({ ok: true, data: { run: plain, companyResults: [] } });
    render(<RunsTab integration={{ id: 'integration-1', name: 'Breeze', resources: [] } as never}
      mappings={[]} runs={[plain] as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
    expect(await screen.findByText(/kind: scheduled/)).toBeInTheDocument();
    expect(screen.queryByText(/source version|API schema version/)).not.toBeInTheDocument();
  });

  it('marks the change on the phone card too', () => {
    mobile = true;
    const changed = run({ sourceVersionChange: { from: '0.125.0', to: '0.126.0' } });
    render(<RunsTab integration={{ id: 'integration-1', name: 'Breeze', resources: [] } as never}
      mappings={[]} runs={[changed] as never} sourceLabel="Breeze RMM" />);
    expect(screen.getByText('new version')).toBeInTheDocument();
  });
});

it('shows a run with a mass-removal hold as warnings, not as a routine first miss', () => {
  const totals = {
    fetched: 6, created: 0, updated: 0, unchanged: 6, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0,
    stale: 0, restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
    incomplete: 0, notSeen: 4, redacted: 0, paused: 0, held: 4,
  };
  const run = { id: 'run-held', mode: 'full', kind: 'scheduled', status: 'succeeded', dryRun: false,
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, totals };
  render(<RunsTab integration={{ id: 'integration-1', resources: [] } as never} mappings={[]} runs={[run] as never} />);
  expect(screen.getAllByText('warnings').length).toBeGreaterThan(0);
  expect(screen.queryByText('succeeded')).not.toBeInTheDocument();
  expect(screen.getAllByText(/4 held for review/).length).toBeGreaterThan(0);
});
