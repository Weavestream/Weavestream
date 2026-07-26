import { fetchArticleDetail, fetchArticleFolders, fetchArticlesPage } from './api';

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const COMPANY = 'c0000000-0000-4000-8000-0000000000c1';

beforeEach(() => {
  apiFetch.mockReset();
});

describe('fetchArticlesPage', () => {
  it('always sends limit=50 and nothing else by default', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchArticlesPage(COMPANY);
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/articles?limit=50`,
      { signal: undefined },
    );
  });

  it('sends folderId and cursor iff provided', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchArticlesPage(COMPANY, {
      folderId: 'f0000000-0000-4000-8000-0000000000f1',
      cursor: 'a0000000-0000-4000-8000-0000000000a9',
    });
    const path = apiFetch.mock.calls[0]![0] as string;
    expect(path).toContain('limit=50');
    expect(path).toContain('folderId=f0000000-0000-4000-8000-0000000000f1');
    expect(path).toContain('cursor=a0000000-0000-4000-8000-0000000000a9');
  });

  it('omits cursor for the first page (null pageParam)', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchArticlesPage(COMPANY, { cursor: null });
    expect(apiFetch.mock.calls[0]![0]).not.toContain('cursor=');
  });
});

describe('fetchArticleDetail / fetchArticleFolders', () => {
  it('fetches the detail path', async () => {
    apiFetch.mockResolvedValue({});
    await fetchArticleDetail(COMPANY, 'a0000000-0000-4000-8000-0000000000a1');
    expect(apiFetch).toHaveBeenCalledWith(
      `/companies/${COMPANY}/articles/a0000000-0000-4000-8000-0000000000a1`,
    );
  });

  it('unwraps the folders envelope', async () => {
    apiFetch.mockResolvedValue({ items: [{ id: 'f1' }] });
    await expect(fetchArticleFolders(COMPANY)).resolves.toEqual([{ id: 'f1' }]);
    expect(apiFetch).toHaveBeenCalledWith(`/companies/${COMPANY}/folders`);
  });
});
