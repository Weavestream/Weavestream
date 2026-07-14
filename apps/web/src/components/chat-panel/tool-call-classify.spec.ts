import { isRewriteTargetHallucinated } from './tool-call-classify';

const ART = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('isRewriteTargetHallucinated', () => {
  it('is false for a non-rewrite (patch / create) proposal', () => {
    expect(
      isRewriteTargetHallucinated({
        isRewrite: false,
        targetArticleId: ART,
        knownArticleIds: new Set(),
        baseRevision: undefined,
      }),
    ).toBe(false);
  });

  it('is false when the target is a known article (current page / @-mention)', () => {
    expect(
      isRewriteTargetHallucinated({
        isRewrite: true,
        targetArticleId: ART,
        knownArticleIds: new Set([ART]),
        baseRevision: undefined,
      }),
    ).toBe(false);
  });

  it('is FALSE for an unknown target that carries a captured basis (F2 regression)', () => {
    // Read via get_article in a freeform tab: not the current page, not an
    // @-mention, but the server captured its revision → a real edit target.
    expect(
      isRewriteTargetHallucinated({
        isRewrite: true,
        targetArticleId: ART,
        knownArticleIds: new Set(),
        baseRevision: 7,
      }),
    ).toBe(false);
  });

  it('is true for an unknown target with no captured basis (genuine hallucination)', () => {
    expect(
      isRewriteTargetHallucinated({
        isRewrite: true,
        targetArticleId: ART,
        knownArticleIds: new Set(),
        baseRevision: undefined,
      }),
    ).toBe(true);
  });

  it('treats baseRevision null (unresolved at persist) as no captured basis', () => {
    expect(
      isRewriteTargetHallucinated({
        isRewrite: true,
        targetArticleId: ART,
        knownArticleIds: new Set(),
        baseRevision: null,
      }),
    ).toBe(true);
  });

  it('is false when there is no target article id', () => {
    expect(
      isRewriteTargetHallucinated({
        isRewrite: true,
        targetArticleId: null,
        knownArticleIds: new Set(),
        baseRevision: undefined,
      }),
    ).toBe(false);
  });
});
