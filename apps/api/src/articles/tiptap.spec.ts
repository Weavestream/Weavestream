import {
  tiptapToPlaintext,
  tiptapExcerpt,
  stringToTiptapDoc,
  isValidTiptapDoc,
} from '@weavestream/shared';

describe('tiptapToPlaintext', () => {
  it('returns empty string for null/undefined/non-object input', () => {
    expect(tiptapToPlaintext(null)).toBe('');
    expect(tiptapToPlaintext(undefined)).toBe('');
    expect(tiptapToPlaintext(42)).toBe('');
    expect(tiptapToPlaintext('already a string')).toBe('');
  });

  it('extracts text across paragraphs', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
      ],
    };
    expect(tiptapToPlaintext(doc)).toBe('Hello\nworld');
  });

  it('walks headings, lists, and code blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Runbook' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'first' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'second' }],
                },
              ],
            },
          ],
        },
        {
          type: 'codeBlock',
          content: [{ type: 'text', text: 'systemctl restart' }],
        },
      ],
    };
    const plain = tiptapToPlaintext(doc);
    expect(plain).toContain('Runbook');
    expect(plain).toContain('first');
    expect(plain).toContain('second');
    expect(plain).toContain('systemctl restart');
  });

  it('renders mentions as their label', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'internalLink',
              attrs: { id: 'u-1', kind: 'asset', label: 'Primary DC' },
            },
            { type: 'text', text: ' for details.' },
          ],
        },
      ],
    };
    expect(tiptapToPlaintext(doc)).toBe('See Primary DC for details.');
  });

  it('renders images by alt text', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'image',
              attrs: { src: 'https://…', alt: 'Rack photo' },
            },
          ],
        },
      ],
    };
    expect(tiptapToPlaintext(doc)).toBe('Rack photo');
  });

  it('walks tables as block rows', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Name' }],
                    },
                  ],
                },
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Value' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(tiptapToPlaintext(doc)).toContain('Name');
    expect(tiptapToPlaintext(doc)).toContain('Value');
  });

  it('is resilient to unknown node types', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'customCallout',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Heads up!' }],
            },
          ],
        },
      ],
    };
    expect(tiptapToPlaintext(doc)).toBe('Heads up!');
  });
});

describe('tiptapExcerpt', () => {
  it('truncates long plaintext at a word boundary with an ellipsis', () => {
    const long = Array.from({ length: 50 }, () => 'lorem').join(' ');
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: long }] }],
    };
    const excerpt = tiptapExcerpt(doc, 80);
    expect(excerpt.length).toBeLessThanOrEqual(81);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('returns the full text when under the limit', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'short' }] }],
    };
    expect(tiptapExcerpt(doc, 80)).toBe('short');
  });

  it('skips image alt text so filename-as-alt does not pollute card previews', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: 'https://…', alt: 'image.jpg' } },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Real prose for the card.' }],
        },
      ],
    };
    const ex = tiptapExcerpt(doc, 200);
    expect(ex).not.toContain('image.jpg');
    expect(ex).toContain('Real prose for the card.');
  });
});

describe('stringToTiptapDoc', () => {
  it('round-trips through tiptapToPlaintext', () => {
    const text = 'line one\nline two';
    expect(tiptapToPlaintext(stringToTiptapDoc(text))).toBe(text);
  });
});

describe('isValidTiptapDoc', () => {
  it('accepts doc-rooted objects with optional content', () => {
    expect(isValidTiptapDoc({ type: 'doc' })).toBe(true);
    expect(isValidTiptapDoc({ type: 'doc', content: [] })).toBe(true);
  });
  it('rejects non-doc roots', () => {
    expect(isValidTiptapDoc({ type: 'paragraph' })).toBe(false);
    expect(isValidTiptapDoc(null)).toBe(false);
    expect(isValidTiptapDoc('doc')).toBe(false);
  });
});
