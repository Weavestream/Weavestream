const mockRequestCaches: Array<Map<string, unknown>> = [];

jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    cache:
      <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
        const values = new Map<string, Result>();
        mockRequestCaches.push(values as Map<string, unknown>);
        return (...args: Args): Result => {
          const key = JSON.stringify(args);
          if (!values.has(key)) values.set(key, fn(...args));
          return values.get(key)!;
        };
      },
  };
});

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ getAll: () => [] })),
  headers: jest.fn(async () => new Headers()),
}));

import { RateLimitedError } from '../api-errors';
import { AssetFilterError, getAsset, listAllAssets } from './assets';
import { forMetadata } from './core';

function resetRequestCache() {
  for (const cache of mockRequestCaches) cache.clear();
}

describe('getAsset request memoization', () => {
  beforeEach(resetRequestCache);

  afterEach(() => jest.restoreAllMocks());

  it('shares one upstream read between page content and streamed metadata', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'a-1', name: 'Edge Router' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const [metadataAsset, pageAsset] = await Promise.all([
      getAsset('co-1', 'a-1'),
      getAsset('co-1', 'a-1'),
    ]);

    expect(metadataAsset?.name).toBe('Edge Router');
    expect(pageAsset).toBe(metadataAsset);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      expect.stringMatching('/api/v1/companies/co-1/assets/a-1$'),
    );
  });

  it('prevents metadata and page content from observing split throttle outcomes', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ title: 'Too Many Requests', status: 429 }),
          {
            status: 429,
            headers: {
              'content-type': 'application/problem+json',
              'retry-after': '30',
            },
          },
        ),
      )
      // Without request memoization the page's second read would succeed,
      // while metadata silently fell back to the company title.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'a-1', name: 'Edge Router' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const [metadataResult, pageResult] = await Promise.allSettled([
      forMetadata(() => getAsset('co-1', 'a-1')),
      getAsset('co-1', 'a-1'),
    ]);

    expect(metadataResult).toEqual({ status: 'fulfilled', value: null });
    expect(pageResult.status).toBe('rejected');
    if (pageResult.status === 'rejected') {
      expect(pageResult.reason).toBeInstanceOf(RateLimitedError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a renamed asset again in a later request', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'a-1', name: 'Old Router' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'a-1', name: 'Core Router' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    expect((await getAsset('co-1', 'a-1'))?.name).toBe('Old Router');
    resetRequestCache();
    expect((await getAsset('co-1', 'a-1'))?.name).toBe('Core Router');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('listAllAssets', () => {
  afterEach(() => jest.restoreAllMocks());

  const page = (items: Array<{ id: string }>, nextCursor: string | null) =>
    new Response(JSON.stringify({ items, nextCursor }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('follows nextCursor past the 200-row page and keeps the filters on every request (#97)', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(page([{ id: 'a-1' }, { id: 'a-2' }], 'a-2'))
      .mockResolvedValueOnce(page([{ id: 'a-3' }], null));

    const res = await listAllAssets('co-1', {
      layoutId: 'lay-1',
      q: 'switch',
      fieldFilters: { vendor: 'acme' },
    });

    expect(res.items.map((a) => a.id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(res.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const urls = fetchMock.mock.calls.map(([u]) => new URL(String(u)));
    for (const url of urls) {
      expect(url.pathname).toMatch(/\/api\/v1\/companies\/co-1\/assets$/);
      expect(url.searchParams.get('limit')).toBe('200');
      expect(url.searchParams.get('layout')).toBe('lay-1');
      expect(url.searchParams.get('q')).toBe('switch');
      expect(url.searchParams.get('field.vendor')).toBe('acme');
    }
    expect(urls[0]!.searchParams.has('cursor')).toBe(false);
    expect(urls[1]!.searchParams.get('cursor')).toBe('a-2');
  });

  const problem = (body: Record<string, unknown>) =>
    new Response(JSON.stringify({ status: 400, title: 'Bad Request', ...body }), {
      status: 400,
      headers: { 'content-type': 'application/problem+json' },
    });

  it('throws AssetFilterError with the API message when a field filter is refused (#99)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      problem({
        error: 'UnknownFilterField',
        slug: 'nope',
        detail: 'No field "nope" exists on any layout.',
      }),
    );

    const err = await listAllAssets('co-1', { fieldFilters: { nope: 'x' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssetFilterError);
    expect((err as Error).message).toBe('No field "nope" exists on any layout.');
  });

  it('keeps the empty-page fallback for other 4xx responses', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(problem({ detail: 'Something else' }));

    const res = await listAllAssets('co-1');
    expect(res.items).toEqual([]);
  });
});
