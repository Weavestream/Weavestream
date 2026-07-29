import {
  buildPatchPreview,
  computeLineDiff,
  DIFF_MAX_CELLS,
  flattenFolderTree,
  isRewriteTargetHallucinated,
  proposalBaseFromArticle,
  type PatchSource,
} from './article-proposal.js';

const ART = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ---------------------------------------------------------------------
// isRewriteTargetHallucinated — relocated verbatim from
// apps/web/src/components/chat-panel/tool-call-classify.spec.ts
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// computeLineDiff
// ---------------------------------------------------------------------

describe('computeLineDiff', () => {
  it('marks unchanged, added, and deleted lines', () => {
    const ops = computeLineDiff(['a', 'b', 'c'], ['a', 'x', 'c'])!;
    expect(ops).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('handles pure appends and pure deletions (tails)', () => {
    expect(computeLineDiff(['a'], ['a', 'b', 'c'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
    expect(computeLineDiff(['a', 'b'], [])).toEqual([
      { kind: 'del', text: 'a' },
      { kind: 'del', text: 'b' },
    ]);
  });

  it('returns ops just under the cell budget and null just over it', () => {
    // (n+1)·(m+1) budget: pick n so a square diff straddles the cap.
    const side = Math.floor(Math.sqrt(DIFF_MAX_CELLS)) - 1; // (side+1)^2 <= cap
    const under = new Array<string>(side).fill('line');
    expect(computeLineDiff(under, under)).not.toBeNull();

    const over = new Array<string>(side + 2).fill('line');
    expect(computeLineDiff(over, over)).toBeNull();
  });

  it('the budget stops the pathological newline-heavy article, not real diffs', () => {
    // A 500 KB body of single-character lines is ~250 000 lines; squared
    // that is ~62.5e9 cells — orders of magnitude over budget.
    const lines = 250_000;
    expect((lines + 1) * (lines + 1)).toBeGreaterThan(DIFF_MAX_CELLS);
    // While a large-but-real runbook (2 000 lines) stays comfortably in.
    expect(2_001 * 2_001).toBeLessThanOrEqual(DIFF_MAX_CELLS);
  });
});

// ---------------------------------------------------------------------
// buildPatchPreview — the full ladder
// ---------------------------------------------------------------------

describe('buildPatchPreview', () => {
  const READY: PatchSource = {
    status: 'ready',
    markdown: 'Before\n\nOld text\n\nAfter',
    revision: 7,
    isRichText: false,
  };
  const EDITS = [{ old_text: 'Old text', new_text: 'New text' }];

  it('passes loading through', () => {
    expect(buildPatchPreview({ status: 'loading' }, 7, undefined, EDITS)).toEqual({
      status: 'loading',
    });
  });

  it('idle (no company/article to fetch) is the unavailable-for-preview error', () => {
    expect(buildPatchPreview({ status: 'idle' }, 7, undefined, EDITS)).toEqual({
      status: 'error',
      message: 'The target article is unavailable for preview.',
    });
  });

  it('propagates a fetch error source', () => {
    const err: PatchSource = { status: 'error', message: 'nope' };
    expect(buildPatchPreview(err, 7, undefined, EDITS)).toBe(err);
  });

  it('refuses a non-number baseRevision', () => {
    for (const base of [null, undefined] as const) {
      expect(buildPatchPreview(READY, base, undefined, EDITS)).toEqual({
        status: 'error',
        message: 'This proposal was not based on a confirmed article revision.',
      });
    }
  });

  it('detects client-side staleness (fetched revision moved past the basis)', () => {
    expect(buildPatchPreview(READY, 6, undefined, EDITS)).toEqual({
      status: 'error',
      message:
        'The article changed after this proposal was drafted. Ask the assistant to redo the edit.',
    });
  });

  it('no edits + no title = no changes', () => {
    expect(buildPatchPreview(READY, 7, undefined, undefined)).toEqual({
      status: 'error',
      message: 'The proposed edit does not contain any changes.',
    });
  });

  it('a title-only patch previews ready with the body unchanged', () => {
    expect(buildPatchPreview(READY, 7, 'Renamed', undefined)).toEqual({
      status: 'ready',
      before: READY.markdown,
      markdown: READY.markdown,
    });
  });

  it('rejects malformed edit arrays', () => {
    for (const bad of [[], [{ old_text: '', new_text: 'x' }], [{ old_text: 'x' }]] as never[]) {
      expect(buildPatchPreview(READY, 7, undefined, bad)).toEqual({
        status: 'error',
        message: 'The proposed edit is malformed.',
      });
    }
  });

  it('names the failing edit for not-found and ambiguous old_text', () => {
    expect(
      buildPatchPreview(READY, 7, undefined, [{ old_text: 'Missing', new_text: 'x' }]),
    ).toEqual({
      status: 'error',
      message: 'Edit 1 no longer matches the article text.',
    });
    const dup: PatchSource = { ...READY, markdown: 'Old text\nOld text' };
    expect(
      buildPatchPreview(dup, 7, undefined, EDITS),
    ).toEqual({
      status: 'error',
      message:
        'Edit 1 matches more than one passage. Ask the assistant to include more surrounding text.',
    });
  });

  it('produces the before/after pair when everything lines up', () => {
    expect(buildPatchPreview(READY, 7, undefined, EDITS)).toEqual({
      status: 'ready',
      before: READY.markdown,
      markdown: 'Before\n\nNew text\n\nAfter',
    });
  });
});

// ---------------------------------------------------------------------
// proposalBaseFromArticle
// ---------------------------------------------------------------------

describe('proposalBaseFromArticle', () => {
  it('uses markdownSource for markdown articles', () => {
    expect(
      proposalBaseFromArticle({
        editorMode: 'markdown',
        markdownSource: '# Hi',
        content: null,
        revision: 3,
      }),
    ).toEqual({ markdown: '# Hi', revision: 3, isRichText: false });
  });

  it('converts tiptap content and flags rich text', () => {
    const base = proposalBaseFromArticle({
      editorMode: 'tiptap',
      markdownSource: null,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
      },
      revision: 9,
    });
    expect(base.isRichText).toBe(true);
    expect(base.revision).toBe(9);
    expect(base.markdown).toContain('Body');
  });

  it('treats a null markdownSource as empty rather than crashing', () => {
    expect(
      proposalBaseFromArticle({
        editorMode: 'markdown',
        markdownSource: null,
        content: null,
        revision: 1,
      }).markdown,
    ).toBe('');
  });
});

// ---------------------------------------------------------------------
// flattenFolderTree
// ---------------------------------------------------------------------

describe('flattenFolderTree', () => {
  it('flattens depth-first with depth annotations', () => {
    expect(
      flattenFolderTree([
        {
          id: 'a',
          name: 'A',
          children: [
            { id: 'a1', name: 'A1', children: [{ id: 'a1x', name: 'A1X', children: [] }] },
          ],
        },
        { id: 'b', name: 'B', children: [] },
      ]),
    ).toEqual([
      { id: 'a', name: 'A', depth: 0 },
      { id: 'a1', name: 'A1', depth: 1 },
      { id: 'a1x', name: 'A1X', depth: 2 },
      { id: 'b', name: 'B', depth: 0 },
    ]);
  });
});
