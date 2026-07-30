import { normaliseTiptapDoc } from './tiptap-doc.js';

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
};

const EMPTY = { type: 'doc', content: [{ type: 'paragraph' }] };

describe('normaliseTiptapDoc', () => {
  it('returns a valid doc by reference', () => {
    expect(normaliseTiptapDoc(DOC)).toBe(DOC);
  });

  it('accepts a doc with no content array', () => {
    const doc = { type: 'doc' };
    expect(normaliseTiptapDoc(doc)).toBe(doc);
  });

  it('unwraps the legacy { v, plain } wrapper when v is a real doc', () => {
    expect(normaliseTiptapDoc({ v: DOC, plain: 'hi' })).toBe(DOC);
  });

  it('rejects a legacy wrapper whose v is not a doc (tightened on promotion)', () => {
    // Previously any object with a `type` key escaped as a "doc"; a
    // paragraph root would then crash or blank the reader.
    expect(normaliseTiptapDoc({ v: { type: 'paragraph' }, plain: 'x' })).toEqual(EMPTY);
  });

  it('rejects a legacy wrapper with garbage v', () => {
    expect(normaliseTiptapDoc({ v: 42 })).toEqual(EMPTY);
    expect(normaliseTiptapDoc({ v: null })).toEqual(EMPTY);
  });

  it('rejects a doc whose content is not an array', () => {
    expect(normaliseTiptapDoc({ type: 'doc', content: 'nope' })).toEqual(EMPTY);
  });

  it('wraps a non-blank string as a single paragraph', () => {
    expect(normaliseTiptapDoc('plain text')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'plain text' }] },
      ],
    });
  });

  // Annotated as `[unknown, string]` because the cases are deliberately
  // heterogeneous: without it TS infers a union of seven tuple types and
  // the callback parameter has no single assignable signature.
  it.each<[unknown, string]>([
    ['', 'blank string'],
    ['   ', 'whitespace'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'empty object'],
    [{ type: 'paragraph' }, 'non-doc root'],
    [7, 'number'],
  ])('falls through to the empty doc for %p (%s)', (value) => {
    expect(normaliseTiptapDoc(value)).toEqual(EMPTY);
  });
});
