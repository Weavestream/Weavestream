/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DomainsSyncTab } from './domains-sync-tab';

jest.mock('../../../../../../lib/timezone-context', () => ({
  FormattedDateTime: ({ value }: { value: string }) => <>{value}</>,
}));
const apiFetch = jest.fn();
jest.mock('../../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
const push = jest.fn();
jest.mock('../../../../../../components/ui', () => {
  const actual = jest.requireActual('../../../../../../components/ui');
  return { ...actual, useToast: () => ({ push }) };
});

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const integration = {
  id: 'int-1',
  config: { domainsCompanySlug: 'hody', domainsCompanyId: '00000000-0000-4000-8000-0000000000aa' },
} as never;

function run(p: object) {
  return {
    id: RUN_ID,
    kind: 'manual',
    status: 'succeeded',
    createdAt: '2026-10-08T00:00:00.000Z',
    startedAt: null,
    finishedAt: '2026-10-08T00:01:00.000Z',
    result: null,
    error: null,
    ...p,
  } as never;
}

afterEach(() => {
  apiFetch.mockReset();
  push.mockReset();
  jest.useRealTimers();
});

it('shows why the latest run failed', () => {
  render(
    <DomainsSyncTab
      integration={integration}
      initialRun={run({ status: 'failed', error: 'Cloudflare GET … returned 403: Authentication error' })}
    />,
  );
  expect(screen.getByText('Failed')).toBeInTheDocument();
  expect(screen.getByText(/returned 403: Authentication error/)).toBeInTheDocument();
});

it('shows the counts of a successful run', () => {
  render(
    <DomainsSyncTab
      integration={integration}
      initialRun={run({ result: { enabled: true, created: 2, updated: 5, adopted: 1, missing: 0, skipped: 2 } })}
    />,
  );
  expect(
    screen.getByText(/2 new, 5 updated, 1 taken over, 0 no longer on the account, 2 skipped/),
  ).toBeInTheDocument();
});

it('polls a started run until it ends, then reports the failure', async () => {
  jest.useFakeTimers();
  apiFetch
    .mockResolvedValueOnce({ ok: true, data: { queued: true, runId: RUN_ID } })
    .mockResolvedValueOnce({ ok: true, data: { run: run({ status: 'queued', finishedAt: null }) } })
    .mockResolvedValueOnce({ ok: true, data: { run: run({ status: 'failed', error: 'boom' }) } });
  render(<DomainsSyncTab integration={integration} initialRun={null} />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sync domains now' }));
  });
  expect(screen.getByText('Queued')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();

  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(screen.getByText('boom')).toBeInTheDocument();
  expect(push).toHaveBeenLastCalledWith(expect.stringMatching(/Domain sync failed/), 'danger');
  expect(apiFetch).toHaveBeenCalledTimes(3);
});

it('keeps polling when the first status read fails, and says so after repeated failures', async () => {
  jest.useFakeTimers();
  apiFetch
    .mockResolvedValueOnce({ ok: true, data: { queued: true, runId: RUN_ID } })
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce({ ok: true, data: { run: run({ result: { enabled: true, created: 1, updated: 0, adopted: 0, missing: 0, skipped: 0 } }) } });
  render(<DomainsSyncTab integration={integration} initialRun={null} />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sync domains now' }));
  });
  // The POST alone shows the run as queued and keeps the button disabled.
  expect(screen.getByText('Queued')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();

  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(screen.getByText(/Could not refresh the sync status/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();

  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(screen.getByText('Succeeded')).toBeInTheDocument();
  expect(screen.queryByText(/Could not refresh/)).not.toBeInTheDocument();
  expect(push).toHaveBeenLastCalledWith(expect.stringMatching(/Domain sync finished: 1 new/), 'ok');
});

it('ignores a status read about another run while its own run is queued', async () => {
  jest.useFakeTimers();
  apiFetch
    .mockResolvedValueOnce({ ok: true, data: { queued: true, runId: RUN_ID } })
    .mockResolvedValueOnce({ ok: true, data: { run: run({ id: 'older-run', status: 'failed', error: 'old' }) } });
  render(<DomainsSyncTab integration={integration} initialRun={null} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sync domains now' }));
  });
  expect(screen.getByText('Queued')).toBeInTheDocument();
  expect(screen.queryByText('old')).not.toBeInTheDocument();
});
