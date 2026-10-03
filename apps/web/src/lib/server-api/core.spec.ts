const mockCookies = jest.fn();
const mockHeaders = jest.fn();

jest.mock('next/headers', () => ({
  cookies: () => mockCookies(),
  headers: () => mockHeaders(),
}));

// `notFound()` throws a tagged control-flow error in Next; a plain sentinel
// is enough to tell it apart from the two API-availability errors.
class MockNotFoundSignal extends Error {}
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new MockNotFoundSignal('NEXT_NOT_FOUND');
  },
}));

import { ApiUnavailableError, RateLimitedError } from '../api-errors';
import { RESOLVED_CLIENT_IP_HEADER } from '../client-ip';
import {
  forMetadata,
  serverApiFetch,
  throwUnlessFound,
  type ServerApiResponse,
} from './core';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
  contentType = 'application/json',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType, ...headers },
  });
}

function rateLimited(headers: Record<string, string>): Response {
  return jsonResponse(
    { title: 'Too Many Requests', status: 429 },
    429,
    headers,
    'application/problem+json',
  );
}

/** A Node `fetch` failure with an undici-style `cause.code`. */
function networkError(code: string): Error {
  return new TypeError('fetch failed', { cause: { code } });
}

let fetchMock: jest.SpyInstance;
let warnMock: jest.SpyInstance;
let sleeps: number[];

beforeEach(() => {
  mockCookies.mockResolvedValue({ getAll: () => [] });
  mockHeaders.mockResolvedValue(new Headers());
  fetchMock = jest.spyOn(global, 'fetch');
  warnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Run the backoff sleeps immediately and record their durations, so the
  // retry schedule is asserted without spending ~5s of real time per test.
  sleeps = [];
  jest.spyOn(global, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    sleeps.push(ms ?? 0);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  jest.restoreAllMocks();
  mockCookies.mockReset();
  mockHeaders.mockReset();
});

describe('serverApiFetch request', () => {
  it('calls the versioned API path with no-store and a JSON Accept header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await serverApiFetch('/companies');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/companies$/);
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
  });

  it('keeps a caller-supplied Accept header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await serverApiFetch('/x', { headers: { Accept: 'text/csv' } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('accept')).toBe('text/csv');
  });

  it('forwards cookies except the long-lived refresh cookie', async () => {
    mockCookies.mockResolvedValue({
      getAll: () => [
        { name: 'ws_session', value: 'refresh' },
        { name: 'ws_session_access', value: 'access' },
        { name: 'ws_csrf', value: 'csrf' },
      ],
    });
    fetchMock.mockResolvedValue(jsonResponse({}));

    await serverApiFetch('/me');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('cookie')).toBe(
      'ws_session_access=access; ws_csrf=csrf',
    );
  });

  it('forwards only the resolved client IP, not the inbound XFF chain', async () => {
    mockHeaders.mockResolvedValue(
      new Headers({
        'x-forwarded-for': '6.6.6.6, 10.0.0.1',
        [RESOLVED_CLIENT_IP_HEADER]: '203.0.113.7',
        'x-forwarded-proto': 'https',
        host: 'docs.example.test',
      }),
    );
    fetchMock.mockResolvedValue(jsonResponse({}));

    await serverApiFetch('/me');

    const sent = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('x-forwarded-proto')).toBe('https');
    expect(sent.get('x-forwarded-host')).toBe('docs.example.test');
  });

  it('still fetches outside a request scope, where headers() throws', async () => {
    mockHeaders.mockRejectedValue(new Error('outside request scope'));
    fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

    const res = await serverApiFetch<{ id: number }>('/x');

    expect(res.data).toEqual({ id: 1 });
    const sent = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(sent.has('x-forwarded-for')).toBe(false);
  });
});

describe('serverApiFetch response unwrapping', () => {
  it('puts a 2xx JSON body on data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'a-1' }));

    const res = await serverApiFetch<{ id: string }>('/x');

    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { id: 'a-1' },
      problem: undefined,
      retryAfterSeconds: undefined,
    });
  });

  it('puts a problem+json body on problem, never on data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ title: 'Forbidden', status: 403 }, 403, {}, 'application/problem+json'),
    );

    const res = await serverApiFetch('/x');

    expect(res.ok).toBe(false);
    expect(res.data).toBeNull();
    expect(res.problem).toEqual({ title: 'Forbidden', status: 403 });
  });

  it('puts a non-2xx plain JSON body on problem', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Bad' }, 400));

    const res = await serverApiFetch('/x');

    expect(res.data).toBeNull();
    expect(res.problem).toEqual({ message: 'Bad' });
  });

  it('leaves data null for a malformed JSON body', async () => {
    fetchMock.mockResolvedValue(
      new Response('{not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await serverApiFetch('/x');

    expect(res.ok).toBe(true);
    expect(res.data).toBeNull();
  });

  it('leaves data and problem empty for a non-JSON body', async () => {
    fetchMock.mockResolvedValue(
      new Response('id,name', { status: 200, headers: { 'content-type': 'text/csv' } }),
    );

    const res = await serverApiFetch('/x');

    expect(res.ok).toBe(true);
    expect(res.data).toBeNull();
    expect(res.problem).toBeUndefined();
  });
});

describe('serverApiFetch Retry-After', () => {
  it('reports no cooldown for a non-429 response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503, { 'retry-after': '10' }));

    const res = await serverApiFetch('/x');

    expect(res.retryAfterSeconds).toBeUndefined();
  });

  it('reads the per-route retry-after header in seconds', async () => {
    fetchMock.mockResolvedValue(rateLimited({ 'retry-after': '45' }));

    expect((await serverApiFetch('/x')).retryAfterSeconds).toBe(45);
  });

  it('takes the longer of retry-after and retry-after-global', async () => {
    fetchMock.mockResolvedValue(
      rateLimited({ 'retry-after': '12', 'retry-after-global': '50' }),
    );

    expect((await serverApiFetch('/x')).retryAfterSeconds).toBe(50);
  });

  it('treats a value above 1000 as milliseconds', async () => {
    fetchMock.mockResolvedValue(rateLimited({ 'retry-after-global': '59841' }));

    expect((await serverApiFetch('/x')).retryAfterSeconds).toBe(60);
  });

  it('rounds a fractional cooldown up', async () => {
    fetchMock.mockResolvedValue(rateLimited({ 'retry-after': '2.2' }));

    expect((await serverApiFetch('/x')).retryAfterSeconds).toBe(3);
  });

  it.each([
    ['absent', {}],
    ['unparseable', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }],
    ['negative', { 'retry-after': '-5' }],
    ['zero', { 'retry-after': '0' }],
  ])('defaults to 30s when the header is %s', async (_label, headers) => {
    fetchMock.mockResolvedValue(rateLimited(headers));

    expect((await serverApiFetch('/x')).retryAfterSeconds).toBe(30);
  });

  it('does not retry a 429', async () => {
    fetchMock.mockResolvedValue(rateLimited({ 'retry-after': '5' }));

    await serverApiFetch('/x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('serverApiFetch retries and transport errors', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET'])(
    'retries a GET on %s and returns the later success',
    async (code) => {
      fetchMock
        .mockRejectedValueOnce(networkError(code))
        .mockRejectedValueOnce(networkError(code))
        .mockResolvedValueOnce(jsonResponse({ id: 'a-1' }));

      const res = await serverApiFetch<{ id: string }>('/x');

      expect(res.data).toEqual({ id: 'a-1' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([200, 400]);
    },
  );

  it('reads the code from an AggregateError-style errors[] cause', async () => {
    fetchMock
      .mockRejectedValueOnce(
        new TypeError('fetch failed', {
          cause: { errors: [{ code: 'ECONNREFUSED' }] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}));

    await serverApiFetch('/x');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries an AbortError', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abort).mockResolvedValueOnce(jsonResponse({}));

    await serverApiFetch('/x');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the full GET schedule and flags a network error', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNREFUSED'));

    const res = await serverApiFetch('/companies');

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleeps).toEqual([200, 400, 800, 1500, 2400]);
    expect(res).toEqual({
      ok: false,
      status: 503,
      data: null,
      networkError: true,
      problem: {
        type: 'about:blank',
        title: 'API unreachable',
        status: 503,
        detail: 'fetch failed',
        networkError: true,
      },
    });
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toBe(
      '[server-api] GET /companies failed after 6 attempt(s): fetch failed',
    );
  });

  it('retries HEAD like GET', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNREFUSED'));

    await serverApiFetch('/x', { method: 'head' });

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'never re-fires a %s',
    async (method) => {
      fetchMock.mockRejectedValue(networkError('ECONNREFUSED'));

      const res = await serverApiFetch('/x', { method });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      expect(res.networkError).toBe(true);
    },
  );

  it('does not retry an error that is not a transient network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Invalid URL'));

    const res = await serverApiFetch('/x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.networkError).toBe(true);
    expect(res.status).toBe(503);
  });

  it('does not retry an HTTP 5xx the API actually answered', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'boom' }, 500));

    const res = await serverApiFetch('/x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(res.networkError).toBeUndefined();
  });
});

describe('throwUnlessFound', () => {
  const base = { ok: false, data: null } as const;

  it('returns the data of a successful response', () => {
    expect(
      throwUnlessFound({ ok: true, status: 200, data: { id: 'a-1' } }, '/x'),
    ).toEqual({ id: 'a-1' });
  });

  it('throws RateLimitedError with the cooldown and problem title on 429', () => {
    const res: ServerApiResponse<unknown> = {
      ...base,
      status: 429,
      retryAfterSeconds: 42,
      problem: { title: 'Slow down' },
    };

    expect(() => throwUnlessFound(res, '/x')).toThrow(RateLimitedError);
    try {
      throwUnlessFound(res, '/x');
    } catch (err) {
      expect((err as RateLimitedError).retryAfterSeconds).toBe(42);
      expect((err as RateLimitedError).path).toBe('/x');
      expect((err as Error).message).toContain('Slow down');
    }
  });

  it('defaults a 429 without a cooldown to 30s', () => {
    try {
      throwUnlessFound({ ...base, status: 429 }, '/x');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RateLimitedError).retryAfterSeconds).toBe(30);
    }
  });

  it('throws ApiUnavailableError for a network failure', () => {
    expect(() =>
      throwUnlessFound(
        { ...base, status: 503, networkError: true, problem: { detail: 'ECONNREFUSED' } },
        '/x',
      ),
    ).toThrow(/API unavailable — GET \/x: ECONNREFUSED/);
  });

  it('throws ApiUnavailableError for an API 5xx', () => {
    expect(() => throwUnlessFound({ ...base, status: 502 }, '/x')).toThrow(
      ApiUnavailableError,
    );
  });

  it.each([
    ['a 404', { ...base, status: 404 }],
    ['a 403', { ...base, status: 403 }],
    ['a 2xx with no body', { ok: true, status: 200, data: null }],
  ])('renders not-found for %s', (_label, res) => {
    expect(() => throwUnlessFound(res, '/x')).toThrow(MockNotFoundSignal);
  });
});

describe('forMetadata', () => {
  it('returns the value of a successful read', async () => {
    await expect(forMetadata(async () => 'Title')).resolves.toBe('Title');
  });

  it.each([
    ['ApiUnavailableError', new ApiUnavailableError('/x', 'GET', 'down')],
    ['RateLimitedError', new RateLimitedError('/x', 'GET', 30)],
  ])('falls back to null on %s', async (_label, error) => {
    await expect(
      forMetadata(async () => {
        throw error;
      }),
    ).resolves.toBeNull();
  });

  it('lets not-found control flow propagate', async () => {
    await expect(
      forMetadata(async () => {
        throw new MockNotFoundSignal('NEXT_NOT_FOUND');
      }),
    ).rejects.toBeInstanceOf(MockNotFoundSignal);
  });

  it('lets a genuine bug propagate', async () => {
    await expect(
      forMetadata(async () => {
        throw new TypeError('x is undefined');
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
