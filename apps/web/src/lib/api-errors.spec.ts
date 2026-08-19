import {
  API_UNAVAILABLE_DIGEST,
  ApiUnavailableError,
  RATE_LIMIT_DIGEST_PREFIX,
  RateLimitedError,
  extractProblemDetailOrMessage,
  extractProblemMessage,
  extractProblemMessagePreferMessage,
  isApiUnavailableDigest,
  parseRateLimitDigest,
  unwrapApiResponse,
  unwrapMeResponse,
} from './api-errors';
import type { ServerApiResponse } from './server-api';

function res<T>(partial: Partial<ServerApiResponse<T>>): ServerApiResponse<T> {
  return { ok: false, status: 0, data: null, ...partial };
}

describe('unwrapMeResponse', () => {
  const me = { id: 'u1', name: 'Test User' };

  it('returns the payload for a 2xx with a body', () => {
    expect(unwrapMeResponse(res({ ok: true, status: 200, data: me }))).toBe(me);
  });

  it('throws ApiUnavailableError for the synthetic network-error 503', () => {
    expect(() =>
      unwrapMeResponse(res({ status: 503, networkError: true })),
    ).toThrow(ApiUnavailableError);
    try {
      unwrapMeResponse(res({ status: 503, networkError: true }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ApiUnavailableError).digest).toBe(API_UNAVAILABLE_DIGEST);
    }
  });

  it.each([500, 502, 503])(
    'throws ApiUnavailableError for a real HTTP %i without networkError',
    (status) => {
      expect(() => unwrapMeResponse(res({ status }))).toThrow(
        ApiUnavailableError,
      );
    },
  );

  it('throws RateLimitedError with the cooldown in the digest on 429', () => {
    try {
      unwrapMeResponse(res({ status: 429, retryAfterSeconds: 42 }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).digest).toBe(
        `${RATE_LIMIT_DIGEST_PREFIX}42`,
      );
    }
  });

  it('defaults the 429 cooldown to 30s when the header was absent', () => {
    try {
      unwrapMeResponse(res({ status: 429 }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as RateLimitedError).retryAfterSeconds).toBe(30);
    }
  });

  it.each([401, 403])('returns null for a genuine HTTP %i', (status) => {
    expect(unwrapMeResponse(res({ status }))).toBeNull();
  });

  it('returns null for a 2xx with an empty body', () => {
    expect(unwrapMeResponse(res({ ok: true, status: 200 }))).toBeNull();
  });
});

describe('unwrapApiResponse', () => {
  const asset = { id: 'a1', name: 'Server' };

  it('returns the payload for a 2xx with a body', () => {
    expect(
      unwrapApiResponse(res({ ok: true, status: 200, data: asset }), '/x'),
    ).toBe(asset);
  });

  it('carries the requested path on the unavailable error', () => {
    try {
      unwrapApiResponse(res({ status: 502 }), '/companies/c1/assets/a1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnavailableError);
      expect((err as ApiUnavailableError).path).toBe(
        '/companies/c1/assets/a1',
      );
      expect((err as ApiUnavailableError).digest).toBe(API_UNAVAILABLE_DIGEST);
    }
  });

  it('carries the requested path on the rate-limit error', () => {
    try {
      unwrapApiResponse(
        res({ status: 429, retryAfterSeconds: 7 }),
        '/layouts',
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).path).toBe('/layouts');
    }
  });

  it('returns null for 404 so callers can render notFound()', () => {
    expect(unwrapApiResponse(res({ status: 404 }), '/x')).toBeNull();
  });
});

describe('parseRateLimitDigest', () => {
  it('parses the cooldown seconds', () => {
    expect(parseRateLimitDigest('WS_RATE_LIMITED:42')).toBe(42);
  });

  it('keeps parseInt prefix semantics for a trailing-garbage suffix', () => {
    expect(parseRateLimitDigest('WS_RATE_LIMITED:42abc')).toBe(42);
  });

  it('falls back to 30 for an unparseable suffix', () => {
    expect(parseRateLimitDigest('WS_RATE_LIMITED:abc')).toBe(30);
  });

  it('falls back to 30 for an implausible cooldown', () => {
    expect(parseRateLimitDigest('WS_RATE_LIMITED:0')).toBe(30);
  });

  it('returns null for non-rate-limit digests', () => {
    expect(parseRateLimitDigest('WS_API_UNAVAILABLE')).toBeNull();
    expect(parseRateLimitDigest('something-else')).toBeNull();
    expect(parseRateLimitDigest(undefined)).toBeNull();
  });
});

describe('isApiUnavailableDigest', () => {
  it('matches only the exact digest', () => {
    expect(isApiUnavailableDigest('WS_API_UNAVAILABLE')).toBe(true);
    expect(isApiUnavailableDigest('WS_RATE_LIMITED:42')).toBe(false);
    expect(isApiUnavailableDigest(undefined)).toBe(false);
  });
});

/**
 * The three precedences are NOT interchangeable — each block asserts the case
 * where it diverges from the other two, since that divergence is the only
 * reason three exist. `?? fallback` equivalence to the `problemText` helpers
 * these replaced is pinned explicitly.
 */
describe('extractProblemMessage', () => {
  it('prefers detail over title', () => {
    expect(extractProblemMessage({ detail: 'Port already in use', title: 'Conflict' })).toBe(
      'Port already in use',
    );
  });

  it('falls back to title, then to null', () => {
    expect(extractProblemMessage({ title: 'Conflict' })).toBe('Conflict');
    expect(extractProblemMessage({})).toBeNull();
  });

  it('ignores a message field entirely — that is the other two helpers', () => {
    expect(extractProblemMessage({ message: 'msg' })).toBeNull();
  });

  it('returns non-string fields as null, and handles non-objects', () => {
    expect(extractProblemMessage({ detail: 42, title: null })).toBeNull();
    for (const v of [null, undefined, 'str', 7]) expect(extractProblemMessage(v)).toBeNull();
  });

  it('reproduces the replaced problemText via ?? fallback', () => {
    const problemText = (problem: unknown, fallback: string) =>
      extractProblemMessage(problem) ?? fallback;
    expect(problemText({ detail: 'd' }, 'fb')).toBe('d');
    expect(problemText({ title: 't' }, 'fb')).toBe('t');
    expect(problemText({}, 'fb')).toBe('fb');
    expect(problemText(null, 'fb')).toBe('fb');
  });
});

describe('extractProblemMessagePreferMessage', () => {
  it('puts message first, then detail, then title', () => {
    const all = { message: 'm', detail: 'd', title: 't' };
    expect(extractProblemMessagePreferMessage(all)).toBe('m');
    expect(extractProblemMessagePreferMessage({ detail: 'd', title: 't' })).toBe('d');
    expect(extractProblemMessagePreferMessage({ title: 't' })).toBe('t');
    expect(extractProblemMessagePreferMessage({})).toBeNull();
  });

  it('skips empty strings — the difference from the other two', () => {
    expect(extractProblemMessagePreferMessage({ message: '', detail: 'd' })).toBe('d');
    expect(extractProblemMessage({ detail: '' })).toBe('');
    expect(extractProblemDetailOrMessage({ detail: '' })).toBe('');
  });

  it('does NOT skip whitespace-only strings — only empty ones', () => {
    // The shared `problemMessage` trims; this one checks length. Keeping the
    // distinction is why they are separate helpers.
    expect(extractProblemMessagePreferMessage({ message: '   ', detail: 'd' })).toBe('   ');
  });
});

describe('extractProblemDetailOrMessage', () => {
  it('prefers detail over message', () => {
    expect(extractProblemDetailOrMessage({ detail: 'd', message: 'm' })).toBe('d');
    expect(extractProblemDetailOrMessage({ message: 'm' })).toBe('m');
    expect(extractProblemDetailOrMessage({})).toBeNull();
  });

  it('has no title bucket', () => {
    expect(extractProblemDetailOrMessage({ title: 'Conflict' })).toBeNull();
  });
});
