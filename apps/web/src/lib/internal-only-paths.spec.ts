import { isInternalOnlyUpstreamUrl } from './internal-only-paths';

// All inputs are fully-constructed upstream URLs, exactly what
// proxyToApi builds before it would call fetch.
const B = 'http://api:4000';

describe('isInternalOnlyUpstreamUrl — denied', () => {
  it.each([
    ['exact path', `${B}/api/v1/ip-rules/active`],
    ['with query string', `${B}/api/v1/ip-rules/active?foo=1`],
    ['trailing slash', `${B}/api/v1/ip-rules/active/`],
    ['multiple trailing slashes', `${B}/api/v1/ip-rules/active///`],
    ['uppercase variant', `${B}/API/V1/IP-RULES/ACTIVE`],
    ['mixed case', `${B}/api/v1/Ip-Rules/Active`],
    ['dot-segment traversal', `${B}/api/v1/foo/../ip-rules/active`],
    ['encoded dot-segment traversal', `${B}/api/v1/foo/%2e%2e/ip-rules/active`],
    ['encoded dot-segment at root of path', `${B}/api/v1/%2e%2e/v1/ip-rules/active`],
    ['health catch-all traversal', `${B}/health/../api/v1/ip-rules/active`],
    ['duplicate slashes', `${B}//api//v1//ip-rules//active`],
    ['unparseable url (deny-safe)', 'not a url'],
  ])('denies %s', (_label, url) => {
    expect(isInternalOnlyUpstreamUrl(url)).toBe(true);
  });
});

describe('isInternalOnlyUpstreamUrl — allowed', () => {
  it.each([
    ['ip-rules list (CRUD)', `${B}/api/v1/ip-rules`],
    ['ip-rules by id (CRUD)', `${B}/api/v1/ip-rules/2f1c9b0e-0000-4000-8000-000000000000`],
    ['a longer sibling path', `${B}/api/v1/ip-rules/actives`],
    ['percent-encoded unreserved char resolves to CRUD, not active', `${B}/api/v1/%69p-rules`],
    ['unrelated api path', `${B}/api/v1/security/whoami`],
    ['health probe', `${B}/health/live`],
    ['root', `${B}/`],
  ])('allows %s', (_label, url) => {
    expect(isInternalOnlyUpstreamUrl(url)).toBe(false);
  });
});
