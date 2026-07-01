import { describeError } from './describe-error.js';

describe('describeError', () => {
  it('unwraps the cause chain and tags error codes', () => {
    const cause = Object.assign(new Error('invalid onRequestStart method'), {
      code: 'UND_ERR_INVALID_ARG',
    });
    const e = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeError(e)).toBe(
      'fetch failed ← invalid onRequestStart method [UND_ERR_INVALID_ARG]',
    );
  });

  it('surfaces the first member of an AggregateError', () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
          code: 'ECONNREFUSED',
        }),
      ],
      'fetch failed',
    );
    expect(describeError(agg)).toContain(
      'connect ECONNREFUSED 1.2.3.4:443 [ECONNREFUSED]',
    );
  });

  it('redacts userinfo and query strings from embedded URLs', () => {
    const e = new Error(
      'Action1 GET https://user:pass@app.example.com/api/3.0/things?api_key=SECRET&limit=5 returned HTTP 500',
    );
    const out = describeError(e);
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('api_key');
    expect(out).not.toContain('user:pass');
    // Scheme + host + path are preserved for diagnosis.
    expect(out).toContain('https://app.example.com/api/3.0/things');
    expect(out).toContain('returned HTTP 500');
  });

  it('handles non-Error values, nullish, and caps length', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(null)).toBe('unknown error');
    expect(describeError(new Error('x'.repeat(1000)), 50)).toHaveLength(50);
  });

  it('does not infinite-loop on a circular cause chain', () => {
    const a = new Error('a');
    const b = Object.assign(new Error('b'), { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => describeError(a)).not.toThrow();
  });
});
