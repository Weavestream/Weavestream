import {
  API_UNAVAILABLE_DIGEST,
  ApiUnavailableError,
  RATE_LIMIT_DIGEST_PREFIX,
  RateLimitedError,
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
