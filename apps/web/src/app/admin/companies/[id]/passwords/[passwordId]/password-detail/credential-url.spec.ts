import { formatCredentialUrl, shortenPath } from './credential-url';

describe('formatCredentialUrl', () => {
  it('is empty for a missing URL', () => {
    expect(formatCredentialUrl(null)).toBe('');
    expect(formatCredentialUrl('')).toBe('');
  });

  it('shows the bare host for a root URL', () => {
    expect(formatCredentialUrl('https://portal.example.com/')).toBe('portal.example.com');
  });

  it('drops the scheme, port, query, and fragment', () => {
    expect(formatCredentialUrl('https://fw.example.com:8443/admin/login?next=%2F#top')).toBe(
      'fw.example.com/admin/login',
    );
  });

  it('parses a scheme-less host as https', () => {
    expect(formatCredentialUrl('router.local/cgi-bin/luci')).toBe('router.local/cgi-bin/luci');
  });

  it('drops opaque id segments and collapses the repeats they leave', () => {
    expect(
      formatCredentialUrl(
        'https://app.example.com/tenants/3f2504e0-4f89-41d3-9a0c-0305e82c3301/settings',
      ),
    ).toBe('app.example.com/tenants/settings');
    expect(
      formatCredentialUrl(
        'https://app.example.com/a/507f1f77bcf86cd799439011507f1f77/a/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      ),
    ).toBe('app.example.com/a');
  });

  it('falls back to path shortening when the value is not a URL at all', () => {
    expect(formatCredentialUrl('not a url?x=1')).toBe('/not a url');
  });
});

describe('shortenPath', () => {
  it('returns / for an empty or id-only path', () => {
    expect(shortenPath('')).toBe('/');
    expect(shortenPath('/ckv9x2b3c0000abcdefghijkl')).toBe('/');
  });

  it('keeps short readable segments as they are', () => {
    expect(shortenPath('/admin/users')).toBe('/admin/users');
  });

  it('elides the middle of a long segment', () => {
    const long = 'this-is-a-very-long-readable-segment-name';
    expect(shortenPath(`/${long}`)).toBe(`/${long.slice(0, 24)}...${long.slice(-8)}`);
  });

  it('decodes before testing for an opaque id', () => {
    expect(shortenPath('/%33f2504e0-4f89-41d3-9a0c-0305e82c3301/x')).toBe('/x');
  });

  it('keeps a segment whose escape sequence is malformed', () => {
    expect(shortenPath('/bad%E0%A4%A')).toBe('/bad%E0%A4%A');
  });
});
