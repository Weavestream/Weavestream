import { ApiError } from '../../lib/api';
import {
  ARCHIVED_ASSET_EDIT_MESSAGE,
  archiveAsset,
  createAsset,
  extractFieldIssues,
  extractUniqueViolation,
  fetchAssetCountsByLayout,
  fetchAssetCredentials,
  fetchAssetDetail,
  fetchAssetsPage,
  fetchLayout,
  fetchLayouts,
  isArchivedAssetEditError,
  restoreAsset,
  updateAsset,
} from './api';

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const COMPANY = 'c0000000-0000-4000-8000-0000000000c1';
const ASSET = 'b0000000-0000-4000-8000-0000000000b1';
const LAYOUT = 'd0000000-0000-4000-8000-0000000000d1';

beforeEach(() => {
  apiFetch.mockReset();
});

describe('fetchAssetsPage', () => {
  it('always sends limit=50 and nothing else by default', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchAssetsPage(COMPANY);
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/assets?limit=50`,
      { signal: undefined },
    );
  });

  it('sends layout and cursor iff provided, and threads the signal', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    const ctrl = new AbortController();
    await fetchAssetsPage(COMPANY, {
      layoutId: LAYOUT,
      cursor: ASSET,
      signal: ctrl.signal,
    });
    const [path, init] = apiFetch.mock.calls[0]! as [string, { signal?: AbortSignal }];
    expect(path).toContain('limit=50');
    expect(path).toContain(`layout=${LAYOUT}`);
    expect(path).toContain(`cursor=${ASSET}`);
    expect(init.signal).toBe(ctrl.signal);
  });

  it('omits cursor for the first page (null pageParam)', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchAssetsPage(COMPANY, { cursor: null });
    expect(apiFetch.mock.calls[0]![0]).not.toContain('cursor=');
  });

  it('never sends an archived toggle — the archived list view was cut', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchAssetsPage(COMPANY, { layoutId: LAYOUT });
    expect(apiFetch.mock.calls[0]![0]).not.toContain('rchived');
  });
});

describe('reads', () => {
  it('fetches the detail path', async () => {
    apiFetch.mockResolvedValue({});
    await fetchAssetDetail(COMPANY, ASSET);
    expect(apiFetch).toHaveBeenCalledWith(`/companies/${COMPANY}/assets/${ASSET}`);
  });

  it('fetches counts-by-layout', async () => {
    apiFetch.mockResolvedValue({});
    await fetchAssetCountsByLayout(COMPANY);
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/assets/counts-by-layout`,
    );
  });

  it('unwraps the layouts list envelope', async () => {
    apiFetch.mockResolvedValue({ items: [{ id: LAYOUT }] });
    await expect(fetchLayouts()).resolves.toEqual([{ id: LAYOUT }]);
    expect(apiFetch).toHaveBeenCalledWith('/layouts');
  });

  it('unwraps the single-layout envelope', async () => {
    apiFetch.mockResolvedValue({ layout: { id: LAYOUT } });
    await expect(fetchLayout(LAYOUT)).resolves.toEqual({ id: LAYOUT });
    expect(apiFetch).toHaveBeenCalledWith(`/layouts/${LAYOUT}`);
  });

  it('fetches linked credentials via the passwords assetId filter', async () => {
    apiFetch.mockResolvedValue({ items: [] });
    await fetchAssetCredentials(COMPANY, ASSET);
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/passwords?assetId=${ASSET}`,
    );
  });
});

describe('writes', () => {
  it('POSTs create with the JSON body', async () => {
    apiFetch.mockResolvedValue({});
    await createAsset(COMPANY, { assetLayoutId: LAYOUT, fieldValues: {} });
    expect(apiFetch).toHaveBeenCalledWith(`/companies/${COMPANY}/assets`, {
      method: 'POST',
      body: JSON.stringify({ assetLayoutId: LAYOUT, fieldValues: {} }),
    });
  });

  it('PATCHes update', async () => {
    apiFetch.mockResolvedValue({});
    await updateAsset(COMPANY, ASSET, { fieldValues: { hostname: null } });
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/assets/${ASSET}`,
      { method: 'PATCH', body: JSON.stringify({ fieldValues: { hostname: null } }) },
    );
  });

  it('archives via DELETE and restores via POST', async () => {
    apiFetch.mockResolvedValue({});
    await archiveAsset(COMPANY, ASSET);
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/assets/${ASSET}`,
      { method: 'DELETE' },
    );
    await restoreAsset(COMPANY, ASSET);
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/assets/${ASSET}/restore`,
      { method: 'POST' },
    );
  });
});

describe('extractFieldIssues', () => {
  it('keys messages by slug, first message wins, array paths collapse to the head', () => {
    const err = new ApiError(400, {
      error: 'ValidationError',
      issues: [
        { path: 'mgmt_ip', message: 'Enter a valid IPv4 or IPv6 address.' },
        { path: 'mgmt_ip', message: 'second message ignored' },
        { path: 'files.0', message: 'Invalid entry' },
      ],
    });
    expect(extractFieldIssues(err)).toEqual({
      mgmt_ip: 'Enter a valid IPv4 or IPv6 address.',
      files: 'Invalid entry',
    });
  });

  it('returns null for non-validation 400s and non-ApiErrors', () => {
    expect(extractFieldIssues(new ApiError(400, { error: 'UnknownFilterField' }))).toBeNull();
    expect(extractFieldIssues(new ApiError(409, { error: 'ValidationError', issues: [] }))).toBeNull();
    expect(extractFieldIssues(new Error('boom'))).toBeNull();
  });
});

describe('extractUniqueViolation', () => {
  it('extracts slug and conflicting name from a 409', () => {
    const err = new ApiError(409, {
      error: 'UniqueFieldViolation',
      slug: 'serial',
      conflictingAssetId: ASSET,
      conflictingAssetName: 'srv-pines-02',
      message: 'Value already used.',
    });
    expect(extractUniqueViolation(err)).toEqual({
      slug: 'serial',
      conflictingAssetName: 'srv-pines-02',
      message: 'Value already used.',
    });
  });

  it('returns null for other 409s', () => {
    expect(
      extractUniqueViolation(new ApiError(409, { error: 'ExternalIdTaken' })),
    ).toBeNull();
  });
});

describe('isArchivedAssetEditError', () => {
  it('matches the server copy on detail or message', () => {
    expect(
      isArchivedAssetEditError(new ApiError(400, { detail: ARCHIVED_ASSET_EDIT_MESSAGE })),
    ).toBe(true);
    expect(
      isArchivedAssetEditError(new ApiError(400, { message: ARCHIVED_ASSET_EDIT_MESSAGE })),
    ).toBe(true);
    expect(
      isArchivedAssetEditError(new ApiError(400, { detail: 'Already archived' })),
    ).toBe(false);
    expect(isArchivedAssetEditError(new Error('x'))).toBe(false);
  });
});
