/**
 * @jest-environment jsdom
 */
import {
  applyServerUiPrefs,
  applyUiPrefs,
  persistLocalUiPrefs,
  syncUiFromCookie,
  watchUiPrefs,
} from './ui-prefs';

/**
 * jsdom has no `matchMedia`; this stub models exactly the one query the
 * module uses (`prefers-color-scheme: light`) and lets tests flip the
 * OS scheme and fire the change listeners.
 */
function installMatchMedia(lightMatches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: lightMatches,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_: string, cb: () => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_: string, cb: () => void) => {
      listeners.delete(cb);
    },
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn().mockReturnValue(mql),
  });
  return {
    setLight(v: boolean) {
      mql.matches = v;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
  };
}

function clearUiCookie() {
  document.cookie = 'ws_ui=; Path=/; Max-Age=0';
}

function setUiCookie(value: string) {
  document.cookie = `ws_ui=${encodeURIComponent(value)}; Path=/`;
}

function root() {
  return document.documentElement;
}

beforeEach(() => {
  clearUiCookie();
  delete root().dataset.theme;
  delete root().dataset.themePref;
  delete root().dataset.accent;
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.remove());
});

afterEach(() => {
  // @ts-expect-error test cleanup of the stub
  delete window.matchMedia;
  if ('serviceWorker' in navigator) {
    // @ts-expect-error test cleanup of the stub
    delete navigator.serviceWorker;
  }
});

describe('applyUiPrefs', () => {
  it('sets all three data attributes for an explicit preference', () => {
    applyUiPrefs({ uiTheme: 'dark', uiAccent: 'iris' });
    expect(root().dataset.theme).toBe('dark');
    expect(root().dataset.themePref).toBe('dark');
    expect(root().dataset.accent).toBe('iris');

    applyUiPrefs({ uiTheme: 'light', uiAccent: 'teal' });
    expect(root().dataset.theme).toBe('light');
    expect(root().dataset.themePref).toBe('light');
    expect(root().dataset.accent).toBe('teal');
  });

  it('resolves system via matchMedia', () => {
    const media = installMatchMedia(true);
    applyUiPrefs({ uiTheme: 'system', uiAccent: 'lime' });
    expect(root().dataset.theme).toBe('light');
    expect(root().dataset.themePref).toBe('system');

    media.setLight(false);
    applyUiPrefs({ uiTheme: 'system', uiAccent: 'lime' });
    expect(root().dataset.theme).toBe('dark');
  });

  it('resolves system to dark when matchMedia is unavailable', () => {
    applyUiPrefs({ uiTheme: 'system', uiAccent: 'lime' });
    expect(root().dataset.theme).toBe('dark');
  });

  it('collapses the stamped theme-color pair to one un-mediaed meta', () => {
    for (const media of ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']) {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      m.setAttribute('media', media);
      m.content = '#fff';
      document.head.appendChild(m);
    }
    applyUiPrefs({ uiTheme: 'dark', uiAccent: 'lime' });
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]!.hasAttribute('media')).toBe(false);
  });

  it('points the meta at the live --bg when the token resolves', () => {
    root().style.setProperty('--bg', '#0a0a0a');
    applyUiPrefs({ uiTheme: 'dark', uiAccent: 'lime' });
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    expect(meta).not.toBeNull();
    // jsdom resolves inline custom properties through getComputedStyle;
    // if that ever regresses upstream the guard leaves content alone
    // rather than writing an empty string.
    expect(meta!.content).toBe('#0a0a0a');
  });
});

describe('syncUiFromCookie', () => {
  it('applies the cookie preferences', () => {
    setUiCookie('t=light;a=coral');
    syncUiFromCookie();
    expect(root().dataset.theme).toBe('light');
    expect(root().dataset.themePref).toBe('light');
    expect(root().dataset.accent).toBe('coral');
  });

  it('degrades a garbled cookie to the defaults (system/lime)', () => {
    setUiCookie('garbage');
    syncUiFromCookie();
    expect(root().dataset.themePref).toBe('system');
    expect(root().dataset.accent).toBe('lime');
    // No matchMedia in this test → system resolves dark.
    expect(root().dataset.theme).toBe('dark');
  });
});

describe('watchUiPrefs', () => {
  it('re-syncs from the cookie when the tab becomes visible', () => {
    setUiCookie('t=dark;a=lime');
    syncUiFromCookie();
    const teardown = watchUiPrefs();

    setUiCookie('t=light;a=amber');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root().dataset.theme).toBe('light');
    expect(root().dataset.accent).toBe('amber');
    teardown();
  });

  it('follows OS scheme flips only while the pref is system', () => {
    const media = installMatchMedia(false);
    applyUiPrefs({ uiTheme: 'system', uiAccent: 'lime' });
    const teardown = watchUiPrefs();
    expect(root().dataset.theme).toBe('dark');

    media.setLight(true);
    expect(root().dataset.theme).toBe('light');

    // Explicit pref: the OS flip must be ignored.
    // (Cookie agrees with the explicit pref, so the visibility re-sync
    // can't mask a wrongly-listening scheme handler either.)
    setUiCookie('t=dark;a=lime');
    applyUiPrefs({ uiTheme: 'dark', uiAccent: 'lime' });
    media.setLight(false);
    media.setLight(true);
    expect(root().dataset.theme).toBe('dark');
    teardown();
  });

  it('tears down its listeners', () => {
    const media = installMatchMedia(false);
    const teardown = watchUiPrefs();
    expect(media.listenerCount()).toBe(1);
    teardown();
    expect(media.listenerCount()).toBe(0);
  });
});

describe('applyServerUiPrefs', () => {
  function installServiceWorker() {
    const postMessage = jest.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: { postMessage } },
    });
    return postMessage;
  }

  it('rewrites the cookie and re-pins the shell when the cookie disagreed', () => {
    const postMessage = installServiceWorker();
    setUiCookie('t=light;a=lime');
    applyServerUiPrefs({ uiTheme: 'dark', uiAccent: 'iris' });

    expect(root().dataset.theme).toBe('dark');
    expect(root().dataset.accent).toBe('iris');
    expect(decodeURIComponent(document.cookie)).toContain('t=dark;a=iris');
    expect(postMessage).toHaveBeenCalledWith({ type: 'refresh-canonical' });
  });

  it('does neither when the cookie already agrees', () => {
    const postMessage = installServiceWorker();
    setUiCookie('t=dark;a=iris');
    const before = document.cookie;
    applyServerUiPrefs({ uiTheme: 'dark', uiAccent: 'iris' });

    expect(root().dataset.theme).toBe('dark');
    expect(document.cookie).toBe(before);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('survives an absent service worker (first load, dev)', () => {
    setUiCookie('t=light;a=lime');
    expect(() =>
      applyServerUiPrefs({ uiTheme: 'dark', uiAccent: 'teal' }),
    ).not.toThrow();
    expect(root().dataset.accent).toBe('teal');
  });
});

describe('persistLocalUiPrefs', () => {
  it('always writes the cookie and re-pins, even when nothing changed', () => {
    const postMessage = jest.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: { postMessage } },
    });
    setUiCookie('t=dark;a=iris');
    persistLocalUiPrefs({ uiTheme: 'dark', uiAccent: 'iris' });
    expect(decodeURIComponent(document.cookie)).toContain('t=dark;a=iris');
    expect(postMessage).toHaveBeenCalledWith({ type: 'refresh-canonical' });
  });
});
