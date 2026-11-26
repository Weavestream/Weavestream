/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  AssetVersionDetail,
  AssetVersionFieldMeta,
  AssetVersionSummary,
} from '@weavestream/shared';
import { AssetVersionHistoryPanel } from './asset-version-history-panel';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const refresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh, replace: jest.fn() }),
}));
jest.mock('../../../../../../lib/api', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
jest.mock('../../../../../../lib/timezone-context', () => ({
  FormattedShortDateTime: ({ value }: { value: string }) => <span>{value}</span>,
}));
jest.mock('../../../../../../components/ui', () => ({
  Panel: ({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) => (
    <section aria-label={title}>
      {actions}
      {children}
    </section>
  ),
  useToast: () => toast,
}));

const HOST = '13000000-0000-4000-8000-0000000000a1';
const NOTES = '13000000-0000-4000-8000-0000000000a2';
const OS = '13000000-0000-4000-8000-0000000000a3';

const fields: AssetVersionFieldMeta[] = [
  { id: HOST, name: 'Hostname', fieldType: 'TEXT', options: {} },
  { id: NOTES, name: 'Notes', fieldType: 'TEXTAREA', options: {} },
  {
    id: OS,
    name: 'OS',
    fieldType: 'DROPDOWN',
    options: { choices: [{ slug: 'w11', label: 'Windows 11' }] },
  },
];

const BASE = '/companies/co-1/assets/as-1/versions';

function summary(over: Partial<AssetVersionSummary> & { version: number }): AssetVersionSummary {
  return {
    changedFields: [],
    changedBy: '11111111-1111-4111-8111-111111111111',
    changedByName: 'Op',
    changeReason: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    redacted: false,
    ...over,
  };
}

const summaries = [
  summary({ version: 2, changedFields: ['name', HOST, OS] }),
  summary({
    version: 1,
    changedFields: ['name', HOST, NOTES],
    changeReason: 'initial version',
  }),
];

const details: Record<number, AssetVersionDetail> = {
  2: {
    ...summaries[0]!,
    name: 'edge-02',
    externalId: null,
    externalSource: null,
    values: { [HOST]: 'edge-02', [NOTES]: 'rack 4', [OS]: 'w11' },
    redactedFields: [],
    previous: { name: 'edge-01', values: { [HOST]: 'edge-01', [NOTES]: 'rack 4' }, redactedFields: [] },
  },
  1: {
    ...summaries[1]!,
    name: 'edge-01',
    externalId: null,
    externalSource: null,
    values: { [HOST]: 'edge-01', [NOTES]: 'rack 4' },
    redactedFields: [],
    previous: null,
  },
};

/** Routes the panel's GETs: list pages and per-version detail. */
function serve(opts: { pages?: Array<{ items: AssetVersionSummary[]; nextCursor: number | null }> } = {}) {
  const pages = opts.pages ?? [{ items: summaries, nextCursor: null }];
  let page = 0;
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { ok: true };
    const detail = path.match(/\/versions\/(\d+)$/);
    if (detail) return { ok: true, data: details[Number(detail[1])] };
    const p = pages[Math.min(page, pages.length - 1)]!;
    page += 1;
    return { ok: true, data: { fields, items: p.items, nextCursor: p.nextCursor } };
  });
}

function renderPanel(canManage = true) {
  return render(<AssetVersionHistoryPanel companyId="co-1" assetId="as-1" canManage={canManage} />);
}

async function open(canManage = true) {
  const view = renderPanel(canManage);
  fireEvent.click(screen.getByText('Show version history'));
  await screen.findByRole('group', { name: 'Version 2' });
  return view;
}

beforeEach(() => {
  apiFetch.mockReset();
  toast.push.mockReset();
  refresh.mockReset();
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('AssetVersionHistoryPanel loading', () => {
  it('fetches nothing until opened', () => {
    serve();
    renderPanel();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Every change to this asset is kept/)).toBeInTheDocument();
  });

  it('on open loads the lightweight list (limit 20) and the newest version detail only', async () => {
    serve();
    await open();
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}?limit=20`);
    await screen.findByLabelText('Values captured in version 2');
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/2`);
    expect(apiFetch).not.toHaveBeenCalledWith(`${BASE}/1`);
    expect(screen.queryByLabelText('Values captured in version 1')).not.toBeInTheDocument();
  });

  it('shows the changed field names from the summary without any detail request', async () => {
    serve();
    await open();
    const v1 = screen.getByRole('group', { name: 'Version 1' });
    expect(v1).toHaveTextContent('initial version');
    expect(v1).toHaveTextContent('changed: name, Hostname, Notes');
  });

  it('loads an older version only when its changes are shown', async () => {
    serve();
    await open();
    fireEvent.click(screen.getByText('Show changes in version 1'));
    await screen.findByLabelText('Values captured in version 1');
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/1`);
    expect(screen.getByRole('group', { name: 'Version 1' })).not.toHaveTextContent('was:');
  });

  it('pages older versions with the server cursor', async () => {
    serve({
      pages: [
        { items: [summaries[0]!], nextCursor: 2 },
        { items: [summaries[1]!], nextCursor: null },
      ],
    });
    await open();
    expect(screen.queryByRole('group', { name: 'Version 1' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Load older versions'));
    await screen.findByRole('group', { name: 'Version 1' });
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}?limit=20&cursor=2`);
    expect(screen.queryByText('Load older versions')).not.toBeInTheDocument();
  });

  it('shows the server problem and a retry when the list fails', async () => {
    apiFetch.mockResolvedValue({ ok: false, problem: { detail: 'Too many requests' } });
    renderPanel();
    fireEvent.click(screen.getByText('Show version history'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('explains an empty history', async () => {
    serve({ pages: [{ items: [], nextCursor: null }] });
    renderPanel();
    fireEvent.click(screen.getByText('Show version history'));
    expect(await screen.findByText(/No versions yet/)).toBeInTheDocument();
  });

  it('attributes machine writes to "System"', async () => {
    serve({ pages: [{ items: [summary({ version: 2, changedBy: null, changedByName: null, changeReason: 'integration sync' }), summaries[1]!], nextCursor: null }] });
    await open();
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});

describe('AssetVersionHistoryPanel values', () => {
  it('highlights changed fields with previous values and hides unchanged ones by default', async () => {
    serve();
    await open();
    const v2 = screen.getByRole('group', { name: 'Version 2' });
    const host = (await within(v2).findByText('Hostname:')).parentElement!;
    expect(host).toHaveAttribute('data-changed', 'true');
    expect(host).toHaveTextContent('edge-02');
    expect(host).toHaveTextContent('was: edge-01');
    const os = within(v2).getByText('OS:').parentElement!;
    expect(os).toHaveTextContent('Windows 11');
    expect(os).toHaveTextContent('was: (empty)');
    expect(within(v2).queryByText('Notes:')).not.toBeInTheDocument();
    fireEvent.click(within(v2).getByText('Show 1 unchanged field'));
    expect(within(v2).getByText('Notes:').parentElement).toHaveAttribute('data-changed', 'false');
  });

  it('marks a scrubbed value as redacted and offers no restore for it', async () => {
    serve();
    const redacted = { ...details[2]!, redacted: true, values: { [HOST]: 'edge-02' }, redactedFields: [OS] };
    apiFetch.mockImplementation(async (path: string) =>
      /versions\/2$/.test(path)
        ? { ok: true, data: redacted }
        : { ok: true, data: { fields, items: summaries, nextCursor: null } },
    );
    await open();
    const v2 = screen.getByRole('group', { name: 'Version 2' });
    const os = (await within(v2).findByText('OS:')).parentElement!;
    expect(os).toHaveTextContent('(redacted)');
    expect(within(os).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says when every captured value of a version was removed', async () => {
    const wiped = { ...details[2]!, redacted: true, values: {}, redactedFields: [] };
    apiFetch.mockImplementation(async (path: string) =>
      /versions\/2$/.test(path)
        ? { ok: true, data: wiped }
        : { ok: true, data: { fields, items: [{ ...summaries[0]!, redacted: true }], nextCursor: null } },
    );
    await open();
    expect(await screen.findByText(/captured values were removed/)).toBeInTheDocument();
    expect(screen.getByText('redacted')).toBeInTheDocument();
  });
});

describe('AssetVersionHistoryPanel restore', () => {
  it('per-field restore confirms with a forward-only note, posts the field id only, then reloads', async () => {
    serve();
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore this Hostname from version 2' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/forward-only/));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/Only the Hostname changes/));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`${BASE}/2/restore`, {
        method: 'POST',
        body: JSON.stringify({ fields: [HOST] }),
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toast.push).toHaveBeenCalledWith('Restored the Hostname from v2', 'ok');
    // The list is fetched again so the new top version appears.
    await waitFor(() =>
      expect(apiFetch.mock.calls.filter((c) => c[0] === `${BASE}?limit=20`)).toHaveLength(2),
    );
  });

  it('the Name row restores via the name token', async () => {
    serve();
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore this Name from version 2' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`${BASE}/2/restore`, {
        method: 'POST',
        body: JSON.stringify({ fields: ['name'] }),
      }),
    );
  });

  it('whole-version restore posts no body and says the integration link is untouched', async () => {
    serve();
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 2' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/integration link/));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`${BASE}/2/restore`, { method: 'POST' }),
    );
  });

  it('does nothing when the confirm is declined', async () => {
    serve();
    await open();
    (window.confirm as jest.Mock).mockReturnValue(false);
    apiFetch.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 2' }));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows the server problem and does not refresh when the restore fails', async () => {
    serve();
    await open();
    apiFetch.mockImplementation(async (_p: string, init?: { method?: string }) =>
      init?.method === 'POST'
        ? { ok: false, problem: { detail: 'Cannot restore on an archived asset' } }
        : { ok: true, data: { fields, items: summaries, nextCursor: null } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 2' }));
    await waitFor(() => expect(toast.push).toHaveBeenCalledWith(expect.stringMatching(/archived/), 'danger'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('renders no restore buttons for a user who cannot edit (or an archived asset)', async () => {
    serve();
    await open(false);
    await screen.findByLabelText('Values captured in version 2');
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
  });
});
