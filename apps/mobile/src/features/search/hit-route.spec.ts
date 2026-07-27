import { routeForHit } from './hit-route';

describe('routeForHit', () => {
  it('maps the three kinds mobile can open', () => {
    expect(routeForHit('password', 'abc')).toBe('/passwords/abc');
    expect(routeForHit('asset', 'abc')).toBe('/assets/abc');
    expect(routeForHit('article', 'abc')).toBe('/articles/abc');
  });

  it('returns null for kinds without a mobile screen', () => {
    expect(routeForHit('upload', 'abc')).toBeNull();
    expect(routeForHit('domain', 'abc')).toBeNull();
  });

  it('never consults the desktop href', () => {
    // The signature is the assertion: `routeForHit` accepts kind + id
    // only, so a desktop-shaped `hit.href` cannot leak into navigation.
    expect(routeForHit.length).toBe(2);
  });
});
