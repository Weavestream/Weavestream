import {
  fenceInfoLanguage,
  isMermaidLanguage,
  mermaidSourceFromPre,
  type HastNodeLike,
} from './mermaid-fence';

/**
 * The single recognition rule, tested once.
 *
 * It lives here because three surfaces have to agree on it — the two
 * React renderers (via the `language-*` class) and the PDF export (via
 * the fence info string) — and they previously did not: ```` ```MerMaid ````
 * was captioned "Diagram — mermaid" in an export while the app rendered
 * it as ordinary code.
 */

const pre = (className: unknown, text: string): HastNodeLike => ({
  type: 'element',
  tagName: 'pre',
  children: [
    {
      type: 'element',
      tagName: 'code',
      properties: { className },
      children: [{ type: 'text', value: text }],
    },
  ],
});

describe('fenceInfoLanguage', () => {
  it.each([
    ['mermaid', 'mermaid'],
    ['mermaid title="x"', 'mermaid'],
    ['  mermaid  ', 'mermaid'],
    ['MerMaid', 'MerMaid'],
    ['', ''],
    ['   ', ''],
  ])('%p → %p', (info, expected) => {
    expect(fenceInfoLanguage(info)).toBe(expected);
  });

  it('does not normalise, because normalising is what caused the drift', () => {
    // remark keeps the token verbatim when it builds `language-<lang>`,
    // so anything folded here disagrees with what the renderer sees.
    expect(fenceInfoLanguage('m`ermaid')).toBe('m`ermaid');
    expect(fenceInfoLanguage('!!!')).toBe('!!!');
  });
});

describe('isMermaidLanguage', () => {
  it('accepts only the exact token', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true);
  });

  it.each(['MerMaid', 'Mermaid', 'mermaidjs', 'mermaid ', 'm`ermaid', '', null, undefined])(
    'rejects %p',
    (lang) => {
      // Strict on purpose: this decides whether author text is handed to
      // a diagram engine, and a typo rendering as a code block is a
      // visible, self-explanatory outcome. The reverse is not.
      expect(isMermaidLanguage(lang)).toBe(false);
    },
  );
});

describe('mermaidSourceFromPre', () => {
  it('extracts the source of a mermaid fence', () => {
    expect(mermaidSourceFromPre(pre(['language-mermaid'], 'flowchart TD\n'))).toBe(
      'flowchart TD',
    );
  });

  it('accepts a string className, which some pipelines produce', () => {
    expect(mermaidSourceFromPre(pre('language-mermaid', 'graph TD'))).toBe(
      'graph TD',
    );
  });

  it.each([
    ['no class', undefined],
    ['another language', ['language-bash']],
    ['a near miss', ['language-mermaidjs']],
    ['different case', ['language-Mermaid']],
  ])('returns null for %s', (_label, className) => {
    expect(mermaidSourceFromPre(pre(className, 'flowchart TD'))).toBeNull();
  });

  it('returns null for anything that is not a lone <code> text child', () => {
    expect(mermaidSourceFromPre(undefined)).toBeNull();
    expect(mermaidSourceFromPre({ type: 'element', tagName: 'pre' })).toBeNull();
    expect(
      mermaidSourceFromPre({
        type: 'element',
        tagName: 'pre',
        children: [
          { type: 'element', tagName: 'span', properties: { className: ['language-mermaid'] } },
        ],
      }),
    ).toBeNull();
  });

  it('strips only the fence’s trailing newline', () => {
    // The <pre> fallback must stay byte-identical to what the author
    // typed, so interior blank lines survive.
    expect(mermaidSourceFromPre(pre(['language-mermaid'], 'a\n\nb\n'))).toBe(
      'a\n\nb',
    );
  });
});
