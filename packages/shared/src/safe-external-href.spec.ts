import { safeExternalHref } from './safe-external-href';

describe('safeExternalHref', () => {
  it('passes http/https through, case-insensitively', () => {
    expect(safeExternalHref('https://portal.example.com/login')).toBe(
      'https://portal.example.com/login',
    );
    expect(safeExternalHref('http://10.0.0.1:8443/admin')).toBe(
      'http://10.0.0.1:8443/admin',
    );
    expect(safeExternalHref('HTTPS://Example.com/A')).toBe('https://example.com/A');
  });

  it('promotes a scheme-less host to https instead of a relative route', () => {
    // A raw <a href="portal.example.com"> would navigate to
    // /m/passwords/portal.example.com — the exact bug this exists for.
    expect(safeExternalHref('portal.example.com')).toBe('https://portal.example.com/');
    expect(safeExternalHref('example.com/path?q=1')).toBe('https://example.com/path?q=1');
    // Protocol-relative input is attacker-shaped ambiguity; it gets the
    // same https promotion, never the page's scheme.
    expect(safeExternalHref('//example.com/x')).toBe('https://example.com/x');
  });

  it('classifies host:port as a host, not a scheme — the field-gear shape', () => {
    // A bare scheme regex reads `example.com:` as a scheme and would
    // reject exactly the URLs technicians store most (device admin UIs).
    expect(safeExternalHref('example.com:8443')).toBe('https://example.com:8443/');
    expect(safeExternalHref('localhost:8080')).toBe('https://localhost:8080/');
    expect(safeExternalHref('router.local:8443/admin')).toBe(
      'https://router.local:8443/admin',
    );
    expect(safeExternalHref('10.0.0.1:8443')).toBe('https://10.0.0.1:8443/');
    // An out-of-range port fails URL parsing → copy-only, not a throw.
    expect(safeExternalHref('example.com:99999')).toBeNull();
  });

  it('rejects control characters BEFORE parsing — the parser would strip them', () => {
    // WHATWG URL silently removes \t\n\r: without the pre-check these
    // would become a merged host and a smuggled executable scheme.
    expect(safeExternalHref('example.com\n.evil')).toBeNull();
    expect(safeExternalHref('java\tscript:alert(1)')).toBeNull();
    expect(safeExternalHref('https://exa\rmple.com')).toBeNull();
  });

  it('rejects every non-http scheme', () => {
    // eslint-disable-next-line no-script-url -- the rejected input under test
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeExternalHref('data:text/html,hi')).toBeNull();
    expect(safeExternalHref('file:///etc/passwd')).toBeNull();
    expect(safeExternalHref('vbscript:x')).toBeNull();
    expect(safeExternalHref('ssh://host')).toBeNull();
    expect(safeExternalHref('JAVASCRIPT:alert(1)')).toBeNull();
  });

  it('rejects unparseable and empty values', () => {
    expect(safeExternalHref('')).toBeNull();
    expect(safeExternalHref('   ')).toBeNull();
    expect(safeExternalHref('https://')).toBeNull();
    expect(safeExternalHref('http://')).toBeNull();
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(safeExternalHref('  https://example.com  ')).toBe('https://example.com/');
  });
});
