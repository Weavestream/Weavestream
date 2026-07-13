import { applyArticleTextEdits, articlePatchPayloadChars } from './article-patch.js';

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
