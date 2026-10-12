/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../../../components/ui';
import { DifferencesTab } from './differences-tab';
import { apiFetch } from '../../../../../lib/api';

jest.mock('../../../../../lib/api', () => ({ apiFetch: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
const fetchMock = apiFetch as jest.MockedFunction<typeof apiFetch>;

const ids = {
  integration: '00000000-0000-4000-8000-000000000001',
  company: '00000000-0000-4000-8000-0000000000c1',
  company2: '00000000-0000-4000-8000-0000000000c2',
  asset: '00000000-0000-4000-8000-0000000000a1',
  record: '00000000-0000-4000-8000-0000000000e1',
  field: '00000000-0000-4000-8000-0000000000f1',
};
const mapping = (companyId: string, companyName: string) => ({ id: `m-${companyId}`, companyId, companyName }) as never;
const item = {
  syncRecordId: ids.record, companyId: ids.company, companyName: 'Example Co', assetId: ids.asset,
  assetName: 'Workstation 01', assetFieldId: ids.field, fieldLabel: 'Hostname',
  localValue: 'front-desk', sourceValue: 'ws-01', detectedAt: '2026-10-01T00:00:00.000Z',
};

function renderTab() {
  return render(
    <ToastProvider>
      <DifferencesTab
        integrationId={ids.integration}
        mappings={[mapping(ids.company, 'Example Co'), mapping(ids.company2, 'Other Co')]}
        sourceLabel="Level RMM"
      />
    </ToastProvider>,
  );
}

describe('DifferencesTab', () => {
  beforeEach(() => fetchMock.mockReset());

  it('lists open differences with both values, the total and a link to the asset', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: { items: [item], total: 1, nextCursor: null } } as never);
    renderTab();
    expect((await screen.findAllByText('Workstation 01'))[0]!.closest('a')).toHaveAttribute('href', `/admin/companies/${ids.company}/assets/${ids.asset}`);
    expect(screen.getAllByText('front-desk').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ws-01').length).toBeGreaterThan(0);
    expect(screen.getByText('1 open')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/admin/integrations/${ids.integration}/differences`);
  });

  it('filters by company and pages with the cursor', async () => {
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true, status: 200,
      data: path.includes('cursor=') ? { items: [], total: null, nextCursor: null } : { items: [item], total: 3, nextCursor: ids.record },
    }) as never);
    renderTab();
    await screen.findAllByText('Workstation 01');
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: ids.company2 } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/admin/integrations/${ids.integration}/differences?companyId=${ids.company2}`));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/admin/integrations/${ids.integration}/differences?companyId=${ids.company2}&cursor=${ids.record}`,
    ));
  });

  it('Keep ours resolves through the asset company path and reloads the list', async () => {
    fetchMock.mockImplementation(async (path: string) =>
      (path.endsWith('/resolve')
        ? { ok: true, status: 200, data: { ok: true } }
        : { ok: true, status: 200, data: { items: [item], total: 1, nextCursor: null } }) as never,
    );
    renderTab();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Keep ours' }))[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/companies/${ids.company}/assets/${ids.asset}/integration-differences/resolve`,
      { method: 'POST', body: JSON.stringify({ syncRecordId: ids.record, assetFieldId: ids.field, choice: 'local' }) },
    ));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([p]) => String(p).includes('/differences')).length).toBe(2));
  });

  describe('bulk selection', () => {
    const item2 = { ...item, syncRecordId: '00000000-0000-4000-8000-0000000000e2', assetName: 'Workstation 02', localValue: 'lab-pc' };
    const bulkCalls = () => fetchMock.mock.calls.filter(([p]) => String(p).endsWith('/resolve-bulk'));
    const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

    function listing(page: { items: unknown[]; total: number; nextCursor: string | null }, bulk: (body: Record<string, unknown>) => unknown) {
      fetchMock.mockImplementation(async (path: string, init?: RequestInit) =>
        (path.endsWith('/resolve-bulk')
          ? { ok: true, status: 200, data: bulk(JSON.parse(String(init!.body))) }
          : { ok: true, status: 200, data: page }) as never,
      );
    }

    it('selects one row, asks to confirm in the page, sends the items and shows the summary', async () => {
      listing({ items: [item, item2], total: 2, nextCursor: null }, () => ({
        applied: 1, failed: [],
        skipped: [{ syncRecordId: item2.syncRecordId, assetFieldId: ids.field, assetName: 'Workstation 02', reason: 'You cannot edit assets in this company.' }],
        nextCursor: null,
      }));
      const confirmSpy = jest.spyOn(window, 'confirm');
      renderTab();
      fireEvent.click((await screen.findAllByLabelText('Select Hostname on Workstation 02'))[0]!);
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'Use Level RMM value' })[0]!);
      expect(bulkCalls()).toHaveLength(0);
      expect(screen.getByRole('alertdialog')).toHaveTextContent('Write the Level RMM value into 1 difference?');
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(bulkCalls()).toHaveLength(1));
      expect(bodyOf(bulkCalls()[0]!)).toEqual({ choice: 'source', items: [{ syncRecordId: item2.syncRecordId, assetFieldId: ids.field }] });
      expect(await screen.findByText('Used the Level RMM value for 1 difference. Skipped 1, failed 0.')).toBeInTheDocument();
      expect(screen.getByText('Skipped: Workstation 02: You cannot edit assets in this company.')).toBeInTheDocument();
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('select all loaded, then all matching walks the filter with the cursor until it is done', async () => {
      const cursor = '00000000-0000-4000-8000-0000000000e9';
      listing({ items: [item, item2], total: 600, nextCursor: cursor }, (body) => {
        const filter = body['filter'] as { cursor?: string };
        return filter.cursor
          ? { applied: 99, skipped: [], failed: [{ syncRecordId: item.syncRecordId, assetFieldId: ids.field, assetName: 'Workstation 01', reason: 'The integration synced this asset just now. Try again.' }], nextCursor: null }
          : { applied: 500, skipped: [], failed: [], nextCursor: cursor };
      });
      renderTab();
      await screen.findAllByText('Workstation 01');
      fireEvent.change(screen.getByLabelText('Company'), { target: { value: ids.company } });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/admin/integrations/${ids.integration}/differences?companyId=${ids.company}`));
      fireEvent.click(await screen.findByLabelText('Select all loaded differences'));
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Select all 600 matching' }));
      expect(screen.getByText('All 600 matching selected')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'Keep ours' })[0]!);
      expect(screen.getByRole('alertdialog')).toHaveTextContent('Keep the Weavestream value for 600 differences?');
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(await screen.findByText('Kept ours for 599 differences. Skipped 0, failed 1.')).toBeInTheDocument();
      expect(bulkCalls().map(bodyOf)).toEqual([
        { choice: 'local', filter: { companyId: ids.company } },
        { choice: 'local', filter: { companyId: ids.company, cursor } },
      ]);
      expect(screen.getByText('Failed: Workstation 01: The integration synced this asset just now. Try again.')).toBeInTheDocument();
    });

    it('Cancel sends nothing, and a failed request stops early with the reason', async () => {
      fetchMock.mockImplementation(async (path: string) =>
        (path.endsWith('/resolve-bulk')
          ? { ok: false, status: 403, problem: { title: 'Forbidden', status: 403, detail: 'No access.' } }
          : { ok: true, status: 200, data: { items: [item], total: 1, nextCursor: null } }) as never,
      );
      renderTab();
      fireEvent.click((await screen.findAllByLabelText('Select Hostname on Workstation 01'))[0]!);
      fireEvent.click(screen.getAllByRole('button', { name: 'Keep ours' })[0]!);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(bulkCalls()).toHaveLength(0);
      fireEvent.click(screen.getAllByRole('button', { name: 'Keep ours' })[0]!);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(await screen.findByText(/Stopped early: No access/)).toBeInTheDocument();
    });
  });

  it('shows a load error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, problem: { title: 'Forbidden', status: 403, detail: 'No access.' } } as never);
    renderTab();
    expect(await screen.findByText(/No access|Could not load/)).toBeInTheDocument();
  });
});
