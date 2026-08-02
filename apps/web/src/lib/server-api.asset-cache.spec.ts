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

import { RateLimitedError, forMetadata, getAsset } from './server-api';

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
