import {
  TAB_ROOTS,
  clearRememberedLocations,
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

describe('remembered locations', () => {
  beforeEach(() => clearRememberedLocations());

  it('falls back to the tab root when nothing is remembered', () => {
    expect(rememberedLocation('passwords')).toBe(TAB_ROOTS.passwords);
    expect(rememberedLocation('more')).toBe('/more');
  });

  it('returns to the last path visited in that tab', () => {
    rememberLocation('/passwords/abc');
    expect(rememberedLocation('passwords')).toBe('/passwords/abc');
    // Other tabs are unaffected.
    expect(rememberedLocation('assets')).toBe('/assets');
  });

  it('keeps one location per tab, independently', () => {
    rememberLocation('/passwords/abc');
    rememberLocation('/assets/9');
    expect(rememberedLocation('passwords')).toBe('/passwords/abc');
    expect(rememberedLocation('assets')).toBe('/assets/9');
  });

  it('ignores paths that belong to no tab', () => {
    rememberLocation('/login');
    expect(rememberedLocation('passwords')).toBe('/passwords');
  });

  it('clears every tab on an org switch, not just the visible one', () => {
    // The whole point: a remembered `/assets/9` in a background tab
    // belongs to the previous org, and restoring it later would show one
    // client's record under another client's header.
    rememberLocation('/passwords/abc');
    rememberLocation('/assets/9');
    rememberLocation('/articles/x');

    clearRememberedLocations();

    expect(rememberedLocation('passwords')).toBe('/passwords');
    expect(rememberedLocation('assets')).toBe('/assets');
    expect(rememberedLocation('articles')).toBe('/articles');
  });
});
