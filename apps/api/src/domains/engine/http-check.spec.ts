import { parseHstsHeader } from './http-check.js';

describe('parseHstsHeader', () => {
  it('returns absent when header missing', () => {
    const r = parseHstsHeader(null)!;
    expect(r).not.toBeNull();
    expect(r.present).toBe(false);
    expect(r.maxAge).toBeNull();
    expect(r.includeSubDomains).toBe(false);
    expect(r.preload).toBe(false);
  });

  it('parses max-age only', () => {
    const r = parseHstsHeader('max-age=31536000')!;
    expect(r.present).toBe(true);
    expect(r.maxAge).toBe(31_536_000);
    expect(r.includeSubDomains).toBe(false);
    expect(r.preload).toBe(false);
  });

  it('parses includeSubDomains and preload (case-insensitive)', () => {
    const r = parseHstsHeader(
      'max-age=63072000; includeSubDomains; preload',
    )!;
    expect(r.present).toBe(true);
    expect(r.maxAge).toBe(63_072_000);
    expect(r.includeSubDomains).toBe(true);
    expect(r.preload).toBe(true);
  });

  it('handles unusual whitespace/separator combinations', () => {
    const r = parseHstsHeader('max-age=15552000 ; includesubdomains')!;
    expect(r.maxAge).toBe(15_552_000);
    expect(r.includeSubDomains).toBe(true);
  });

  it('marks as present even when only directives, no max-age', () => {
    const r = parseHstsHeader('preload')!;
    expect(r.present).toBe(true);
    expect(r.maxAge).toBeNull();
    expect(r.preload).toBe(true);
  });
});
