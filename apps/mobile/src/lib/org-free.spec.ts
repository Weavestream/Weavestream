import { isOrgFreeEntry, isOrgFreePath, readOrgStamp } from './org-free';

/**
 * These predicates are the single definition of "org-free", and both sides
 * of the scope machinery read them: `org-scope` boots without resolving a
 * company for an org-free entry, and `scoped-nav`'s stale-scope guard
 * exempts it from the mismatch bounce *and* clears the in-memory org on
 * arrival.
 *
 * That makes the stamp gate load-bearing in both directions, which is what
 * these cases pin:
 *
 *  - a *null-stamped* `/profile` (pushed from the launcher, or a reload of
 *    one) must be org-free, or the guard would bounce a zero-company account
 *    away from its own password screen;
 *  - an *org-stamped* `/profile` must NOT be, or arriving from in-org More
 *    would clear the company and leave Back returning to a scoped screen
 *    with nothing scoped.
 */

const ORG = 'c0000000-0000-4000-8000-000000000002';

describe('readOrgStamp', () => {
  it('distinguishes an explicit null from an absent stamp', () => {
    // The whole gate rests on this: `null` means "deliberately org-free",
    // `undefined` means "not stamped yet" (the guard adopts those).
    expect(readOrgStamp({ orgId: null })).toBeNull();
    expect(readOrgStamp({ orgId: ORG })).toBe(ORG);
    expect(readOrgStamp({})).toBeUndefined();
    expect(readOrgStamp(null)).toBeUndefined();
    expect(readOrgStamp(undefined)).toBeUndefined();
    expect(readOrgStamp({ orgId: 42 })).toBeUndefined();
  });
});

describe('isOrgFreePath', () => {
  it('covers the launcher and the index redirect, with or without /m', () => {
    expect(isOrgFreePath('/app')).toBe(true);
    expect(isOrgFreePath('/m/app')).toBe(true);
    expect(isOrgFreePath('/')).toBe(true);
    expect(isOrgFreePath('/m')).toBe(true);
  });

  it('does not cover the stamp-gated surfaces', () => {
    // These are org-free per *entry*, never per path — see below.
    expect(isOrgFreePath('/profile')).toBe(false);
    expect(isOrgFreePath('/more')).toBe(false);
    expect(isOrgFreePath('/search')).toBe(false);
  });
});

describe('isOrgFreeEntry — the account surface (Phase 5c)', () => {
  it('is org-free when the entry is null-stamped', () => {
    // Reached from the launcher: appearance and the account password must
    // work for an account with no companies at all.
    expect(isOrgFreeEntry('/profile', { orgId: null })).toBe(true);
    expect(isOrgFreeEntry('/m/profile', { orgId: null })).toBe(true);
  });

  it('covers the child form by leading segment', () => {
    expect(isOrgFreeEntry('/profile/password', { orgId: null })).toBe(true);
    expect(isOrgFreeEntry('/m/profile/password', { orgId: null })).toBe(true);
  });

  it('is NOT org-free when org-stamped or unstamped', () => {
    // Entering from in-org More keeps that client in context; clearing it
    // would strand Back on a scoped screen with no scope.
    expect(isOrgFreeEntry('/profile', { orgId: ORG })).toBe(false);
    expect(isOrgFreeEntry('/profile/password', { orgId: ORG })).toBe(false);
    expect(isOrgFreeEntry('/profile', {})).toBe(false);
    expect(isOrgFreeEntry('/profile', undefined)).toBe(false);
  });

  it('matches whole segments, not prefixes', () => {
    expect(isOrgFreeEntry('/profiles', { orgId: null })).toBe(false);
  });
});

describe('isOrgFreeEntry — the surfaces that already had this treatment', () => {
  it('keeps More and search stamp-gated exactly as before', () => {
    expect(isOrgFreeEntry('/more', { orgId: null })).toBe(true);
    expect(isOrgFreeEntry('/search', { orgId: null })).toBe(true);
    expect(isOrgFreeEntry('/more', { orgId: ORG })).toBe(false);
    expect(isOrgFreeEntry('/search', { orgId: ORG })).toBe(false);
    expect(isOrgFreeEntry('/search', {})).toBe(false);
  });

  it('leaves ordinary scoped screens alone whatever the stamp says', () => {
    // A null stamp on a company-scoped path is not a licence to render it
    // org-free; the guard herds those to the launcher instead.
    expect(isOrgFreeEntry('/passwords', { orgId: null })).toBe(false);
    expect(isOrgFreeEntry('/assets/abc-123', { orgId: null })).toBe(false);
    expect(isOrgFreeEntry('/articles', { orgId: ORG })).toBe(false);
  });

  it('still treats the launcher as org-free regardless of stamp', () => {
    expect(isOrgFreeEntry('/app', { orgId: ORG })).toBe(true);
    expect(isOrgFreeEntry('/', undefined)).toBe(true);
  });
});
