import { readBrowserCookie } from './cookies';

/**
 * Runs in the default node environment. `readBrowserCookie` reads exactly
 * one browser global, so stubbing it is both sufficient and cheaper than
 * pulling `jest-environment-jsdom` into this package for one spec.
 */
declare let global: { document?: { cookie: string } };

function setCookie(raw: string) {
  global.document = { cookie: raw };
}

afterEach(() => {
  delete global.document;
});

describe('readBrowserCookie', () => {
  it('percent-decodes, which is the reason it exists', () => {
    // Express encodes cookie values on write, so `ws_ui` arrives like
    // this. A caller that skipped the decode would silently fall back to
    // defaults instead of honouring the user's theme — silently, because
    // the parsers downstream are built to tolerate garbage.
    setCookie('ws_ui=t%3Dlight%3Ba%3Dteal');
    expect(readBrowserCookie('ws_ui')).toBe('t=light;a=teal');
  });

  /**
   * `decodeURIComponent('%')` throws a URIError. On mobile this runs
   * before React mounts, so an unhandled throw blanks the entire app
   * over a cosmetic preference cookie.
   */
  it.each(['%', '%zz', '%E0%A4%A', 'ok%'])(
    'returns the raw value rather than throwing on malformed input (%s)',
    (bad) => {
      setCookie(`ws_ui=${bad}`);
      expect(() => readBrowserCookie('ws_ui')).not.toThrow();
      expect(readBrowserCookie('ws_ui')).toBe(bad);
    },
  );

  it('is undefined for an absent cookie', () => {
    setCookie('other=1');
    expect(readBrowserCookie('ws_ui')).toBeUndefined();
  });

  it('is undefined outside a browser', () => {
    delete global.document;
    expect(readBrowserCookie('ws_ui')).toBeUndefined();
  });

  it('does not match a cookie whose name merely ends with the query', () => {
    setCookie('not_ws_ui=nope');
    expect(readBrowserCookie('ws_ui')).toBeUndefined();
  });

  it('escapes regex metacharacters in the name', () => {
    // Unescaped, `.` would match any character and could read a
    // different cookie's value.
    setCookie('axb=wrong; a.b=right');
    expect(readBrowserCookie('a.b')).toBe('right');
  });
});
