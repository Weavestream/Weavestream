import {
  TAB_ROOTS,
  clearRememberedLocations,
  hideTabBarFor,
  rememberLocation,
  rememberedLocation,
  tabIdForPath,
} from './tab-stacks';

describe('tabIdForPath', () => {
  it('matches a tab root', () => {
    expect(tabIdForPath('/passwords')).toBe('passwords');
    expect(tabIdForPath('/articles')).toBe('articles');
    expect(tabIdForPath('/assets')).toBe('assets');
    expect(tabIdForPath('/more')).toBe('more');
  });

  it('matches a pushed screen inside a tab', () => {
    expect(tabIdForPath('/passwords/abc-123')).toBe('passwords');
    expect(tabIdForPath('/assets/9/edit')).toBe('assets');
  });

  it('tolerates the /m basepath being present', () => {
    // TanStack Router reports router-relative paths, but the same helper
    // is handed raw `window.location.pathname` in tests and by the
    // stale-scope guard's fallbacks.
    expect(tabIdForPath('/m/passwords')).toBe('passwords');
    expect(tabIdForPath('/m/more')).toBe('more');
  });

  it('matches on a whole segment, not a prefix', () => {
    // `/assetsomething` is not the assets tab. A `startsWith` check would
    // say it was.
    expect(tabIdForPath('/assetsomething')).toBeNull();
    expect(tabIdForPath('/more-info')).toBeNull();
  });

  it('returns null for non-tab paths', () => {
    expect(tabIdForPath('/')).toBeNull();
    expect(tabIdForPath('/login')).toBeNull();
    expect(tabIdForPath('/mfa/challenge')).toBeNull();
  });
});

describe('hideTabBarFor', () => {
  it('hides the tab bar on the form routes', () => {
    expect(hideTabBarFor('/passwords/new')).toBe(true);
    expect(hideTabBarFor('/passwords/abc-123/edit')).toBe(true);
    expect(hideTabBarFor('/m/passwords/new')).toBe(true);
    expect(hideTabBarFor('/m/passwords/abc-123/edit')).toBe(true);
    // Phase 2c: asset forms are full-viewport pages too.
    expect(hideTabBarFor('/assets/new')).toBe(true);
    expect(hideTabBarFor('/assets/abc-123/edit')).toBe(true);
    expect(hideTabBarFor('/m/assets/new')).toBe(true);
    expect(hideTabBarFor('/m/assets/abc-123/edit')).toBe(true);
  });

  it('keeps the bar everywhere else, including lookalike segments', () => {
    expect(hideTabBarFor('/passwords')).toBe(false);
    expect(hideTabBarFor('/passwords/abc-123')).toBe(false);
    // "edit"/"new" in the wrong position must not blank the bar.
    expect(hideTabBarFor('/passwords/new/edit/x')).toBe(false);
    expect(hideTabBarFor('/passwords/edit')).toBe(false);
    expect(hideTabBarFor('/assets')).toBe(false);
    expect(hideTabBarFor('/assets/abc-123')).toBe(false);
    expect(hideTabBarFor('/assets/edit')).toBe(false);
    expect(hideTabBarFor('/assets/new/edit/x')).toBe(false);
    expect(hideTabBarFor('/articles/new')).toBe(false);
    expect(hideTabBarFor('/more')).toBe(false);
  });
});

describe('remembered locations', () => {
  beforeEach(() => clearRememberedLocations());

  it('falls back to the tab root when nothing is remembered', () => {
    expect(rememberedLocation('passwords')).toEqual({ path: TAB_ROOTS.passwords });
    expect(rememberedLocation('more')).toEqual({ path: '/more' });
  });

  it('returns to the last path visited in that tab', () => {
    rememberLocation('/passwords/abc');
    expect(rememberedLocation('passwords').path).toBe('/passwords/abc');
    // Other tabs are unaffected.
    expect(rememberedLocation('assets').path).toBe('/assets');
  });

  it('remembers the screen-owned search params with the path', () => {
    // The passwords list's filter chips live in `?folder=`/`?view=` —
    // restoring the tab without them silently unfilters the list.
    rememberLocation('/passwords', { folder: 'f1' });
    expect(rememberedLocation('passwords')).toEqual({
      path: '/passwords',
      search: { folder: 'f1' },
    });
    // Empty search normalizes away rather than restoring `?`-noise.
    rememberLocation('/passwords', {});
    expect(rememberedLocation('passwords')).toEqual({
      path: '/passwords',
      search: undefined,
    });
  });

  it('keeps one location per tab, independently', () => {
    rememberLocation('/passwords/abc');
    rememberLocation('/assets/9');
    expect(rememberedLocation('passwords').path).toBe('/passwords/abc');
    expect(rememberedLocation('assets').path).toBe('/assets/9');
  });

  it('ignores paths that belong to no tab', () => {
    rememberLocation('/login');
    expect(rememberedLocation('passwords').path).toBe('/passwords');
  });

  it('clears every tab on an org switch, not just the visible one', () => {
    // The whole point: a remembered `/assets/9` in a background tab
    // belongs to the previous org, and restoring it later would show one
    // client's record under another client's header.
    rememberLocation('/passwords/abc');
    rememberLocation('/assets/9');
    rememberLocation('/articles/x');

    clearRememberedLocations();

    expect(rememberedLocation('passwords').path).toBe('/passwords');
    expect(rememberedLocation('assets').path).toBe('/assets');
    expect(rememberedLocation('articles').path).toBe('/articles');
  });
});
