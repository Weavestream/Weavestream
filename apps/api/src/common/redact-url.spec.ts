import { redactUrl, UNPARSABLE_URL } from './redact-url.js';

describe('redactUrl', () => {
  it('drops a query string carrying a token, keeping scheme/host/path', () => {
    const out = redactUrl('https://api.example.com/v1/sync?token=abc&page=2');
    expect(out).toBe('https://api.example.com/v1/sync');
    expect(out).not.toContain('token');
    expect(out).not.toContain('abc');
  });

  it('drops a benign-only query string', () => {
    expect(redactUrl('https://api.example.com/p?page=2')).toBe(
      'https://api.example.com/p',
    );
  });

  it('strips userinfo', () => {
    const out = redactUrl('https://user:pass@api.example.com/p?k=1');
    expect(out).toBe('https://api.example.com/p');
    expect(out).not.toContain('user:pass');
  });

  it('strips the fragment', () => {
    expect(redactUrl('https://api.example.com/p#access_token=xyz')).toBe(
      'https://api.example.com/p',
    );
  });

  it('preserves the path and a non-default port', () => {
    expect(redactUrl('https://api.example.com:8443/a/b?x=1')).toBe(
      'https://api.example.com:8443/a/b',
    );
  });

  it('handles an IPv6 literal with port', () => {
    expect(redactUrl('http://[::1]:8080/p?k=1')).toBe('http://[::1]:8080/p');
  });

  it('passes a canonical URL with no query through unchanged', () => {
    // Already-canonical input so the assertion isn't coupled to
    // URL.toString() normalization (trailing-slash insertion etc.).
    expect(redactUrl('https://api.example.com/p')).toBe(
      'https://api.example.com/p',
    );
  });

  it('returns a fixed marker for a malformed URL and leaks no query', () => {
    const out = redactUrl('not a url?token=secret');
    expect(out).toBe(UNPARSABLE_URL);
    expect(out).not.toContain('token');
    expect(out).not.toContain('secret');
  });

  it('returns the marker for a malformed URL with userinfo and no query', () => {
    // %zz is an invalid percent-encoding in the authority, so new URL()
    // throws with the credential still present in the input string.
    const out = redactUrl('https://user:pass@%zz/path');
    expect(out).toBe(UNPARSABLE_URL);
    expect(out).not.toContain('user:pass');
  });
});
