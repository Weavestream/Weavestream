jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ getAll: () => [] })),
  headers: jest.fn(async () => new Headers()),
}));

import { collectAllPages } from './core';

type Page = { items: number[]; nextCursor: string | null };

describe('collectAllPages', () => {
  it('returns a single page as the whole list', async () => {
    const fetchPage = jest.fn(
      async (): Promise<Page> => ({ items: [1, 2], nextCursor: null }),
    );

    await expect(collectAllPages(fetchPage, 5)).resolves.toEqual({
      items: [1, 2],
      truncated: false,
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(undefined);
  });

  it('follows nextCursor and keeps the items in order', async () => {
    const pages: Record<string, Page> = {
      start: { items: [1, 2], nextCursor: 'c1' },
      c1: { items: [3, 4], nextCursor: 'c2' },
      c2: { items: [5], nextCursor: null },
    };
    const fetchPage = jest.fn(async (cursor: string | undefined) => pages[cursor ?? 'start']!);

    await expect(collectAllPages(fetchPage, 5)).resolves.toEqual({
      items: [1, 2, 3, 4, 5],
      truncated: false,
    });
    expect(fetchPage.mock.calls.map(([c]) => c)).toEqual([undefined, 'c1', 'c2']);
  });

  it('stops at the ceiling and reports truncated', async () => {
    let n = 0;
    const fetchPage = jest.fn(async (): Promise<Page> => {
      n += 1;
      return { items: [n], nextCursor: `c${n}` };
    });

    await expect(collectAllPages(fetchPage, 3)).resolves.toEqual({
      items: [1, 2, 3],
      truncated: true,
    });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('rejects when a later page fails instead of returning a partial list', async () => {
    const fetchPage = jest
      .fn<Promise<Page>, [string | undefined]>()
      .mockResolvedValueOnce({ items: [1], nextCursor: 'c1' })
      .mockRejectedValueOnce(new Error('upstream down'));

    await expect(collectAllPages(fetchPage, 5)).rejects.toThrow('upstream down');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
