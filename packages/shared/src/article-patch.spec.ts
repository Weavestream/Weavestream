import {
  applyArticleTextEdits,
  articlePatchPayloadChars,
  rawArticlePatchPayloadChars,
} from './article-patch.js';

describe('applyArticleTextEdits', () => {
  it('applies replacements, insertions, and deletions in order', () => {
    const result = applyArticleTextEdits('Alpha\nBeta\nGamma', [
      { old_text: 'Beta', new_text: 'Beta\nInserted' },
      { old_text: 'Alpha\n', new_text: '' },
      { old_text: 'Gamma', new_text: 'Delta' },
    ]);

    expect(result).toEqual({ ok: true, markdown: 'Beta\nInserted\nDelta' });
  });

  it('lets later edits target text produced by earlier edits', () => {
    expect(
      applyArticleTextEdits('one', [
        { old_text: 'one', new_text: 'two' },
        { old_text: 'two', new_text: 'three' },
      ]),
    ).toEqual({ ok: true, markdown: 'three' });
  });

  it('fails atomically when text is missing', () => {
    expect(
      applyArticleTextEdits('one', [
        { old_text: 'one', new_text: 'two' },
        { old_text: 'missing', new_text: 'three' },
      ]),
    ).toEqual({ ok: false, code: 'not_found', editIndex: 1 });
  });

  it('rejects an ambiguous match', () => {
    expect(
      applyArticleTextEdits('same\nsame', [{ old_text: 'same', new_text: 'changed' }]),
    ).toEqual({ ok: false, code: 'ambiguous', editIndex: 0 });
  });

  it('rejects a self-overlapping ambiguous match', () => {
    // `----` occurs at offsets 0, 1, and 2 inside `------`; resuming the
    // second search after the first full match would miss the overlaps
    // and silently replace the leftmost run.
    expect(
      applyArticleTextEdits('------', [{ old_text: '----', new_text: '====' }]),
    ).toEqual({ ok: false, code: 'ambiguous', editIndex: 0 });
  });

  it('matches unicode and line endings exactly', () => {
    expect(
      applyArticleTextEdits('Café\r\nnext', [{ old_text: 'Café\r\n', new_text: '💡\r\n' }]),
    ).toEqual({ ok: true, markdown: '💡\r\nnext' });
  });
});

describe('articlePatchPayloadChars', () => {
  it('counts old and replacement text', () => {
    expect(articlePatchPayloadChars([{ old_text: 'old', new_text: 'newer' }])).toBe(8);
  });
});

describe('rawArticlePatchPayloadChars', () => {
  it('sums string fields on well-formed raw edits', () => {
    expect(
      rawArticlePatchPayloadChars([{ old_text: 'old', new_text: 'newer' }]),
    ).toBe(8);
  });

  it('ignores non-array input and non-string / missing fields', () => {
    expect(rawArticlePatchPayloadChars(null)).toBe(0);
    expect(rawArticlePatchPayloadChars('nope')).toBe(0);
    expect(
      rawArticlePatchPayloadChars([
        { old_text: 'keep', new_text: 42 },
        { old_text: null },
        'garbage',
        { new_text: 'add' },
      ]),
    ).toBe(7);
  });
});
