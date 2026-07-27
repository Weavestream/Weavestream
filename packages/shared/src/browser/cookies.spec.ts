import { parseUiCookie } from '../ui-cookie';
import { readBrowserCookie, writeUiBrowserCookie } from './cookies';

/**
 * Runs in the default node environment. These helpers read exactly two
 * browser globals, so stubbing them is both sufficient and cheaper than
 * pulling `jest-environment-jsdom` into this package for one spec — and
 * for the writer it is strictly better: a plain property stub records
 * the FULL assignment string, attributes included, where jsdom's cookie
 * jar would swallow them.
 */
declare let global: {
  document?: { cookie: string };
  location?: { protocol: string };
};

function setCookie(raw: string) {
  global.document = { cookie: raw };
}

afterEach(() => {
  delete global.document;
  delete global.location;
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

describe('writeUiBrowserCookie', () => {
  it('writes the encoded value with the API-matching attribute set', () => {
    setCookie('');
    global.location = { protocol: 'http:' };
    writeUiBrowserCookie({ uiTheme: 'dark', uiAccent: 'iris' });
    // Value percent-encoded like Express's res.cookie default; host-only
    // (no Domain), Path=/, one-year Max-Age, SameSite=Lax — the exact
    // attributes apps/api/src/auth/cookies.ts uses, minus Secure on
    // plain HTTP.
    expect(global.document!.cookie).toBe(
      'ws_ui=t%3Ddark%3Ba%3Diris; Path=/; Max-Age=31536000; SameSite=Lax',
    );
  });

  it('adds Secure on HTTPS', () => {
    setCookie('');
    global.location = { protocol: 'https:' };
    writeUiBrowserCookie({ uiTheme: 'light', uiAccent: 'teal' });
    expect(global.document!.cookie).toBe(
      'ws_ui=t%3Dlight%3Ba%3Dteal; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    );
  });

  it('round-trips through readBrowserCookie + parseUiCookie', () => {
    setCookie('');
    global.location = { protocol: 'https:' };
    writeUiBrowserCookie({ uiTheme: 'system', uiAccent: 'coral' });
    // The stub holds `ws_ui=<value>; Path=/; …`; the reader's capture
    // stops at the first `;`, exactly as a real cookie jar would return
    // only the value.
    expect(parseUiCookie(readBrowserCookie('ws_ui'))).toEqual({
      uiTheme: 'system',
      uiAccent: 'coral',
    });
  });

  it('no-ops outside a browser', () => {
    delete global.document;
    expect(() =>
      writeUiBrowserCookie({ uiTheme: 'dark', uiAccent: 'lime' }),
    ).not.toThrow();
  });
});
