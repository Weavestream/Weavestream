import { tiptapDocToMarkdown } from './tiptap-markdown.js';
import type { TiptapNode } from './tiptap.js';

function doc(...content: TiptapNode[]): unknown {
  return { type: 'doc', content };
}

function text(t: string, marks?: TiptapNode['marks']): TiptapNode {
  return { type: 'text', text: t, ...(marks ? { marks } : {}) };
}

function paragraph(...content: TiptapNode[]): TiptapNode {
  return { type: 'paragraph', content };
}

describe('tiptapDocToMarkdown', () => {
  it('returns empty string for malformed input', () => {
    expect(tiptapDocToMarkdown(null)).toBe('');
    expect(tiptapDocToMarkdown('nope')).toBe('');
    expect(tiptapDocToMarkdown({})).toBe('');
  });

  it('renders headings and paragraphs with a blank line between blocks', () => {
    const md = tiptapDocToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Setup')] },
        paragraph(text('First step.')),
        paragraph(text('Second step.')),
      ),
    );
    expect(md).toBe('## Setup\n\nFirst step.\n\nSecond step.');
  });

  it('renders inline marks: bold, italic, strike, code, link', () => {
    const md = tiptapDocToMarkdown(
      doc(
        paragraph(
          text('bold', [{ type: 'bold' }]),
          text(' and '),
          text('italic', [{ type: 'italic' }]),
          text(' and '),
          text('gone', [{ type: 'strike' }]),
          text(' and '),
          text('cmd', [{ type: 'code' }]),
          text(' and '),
          text('docs', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        ),
      ),
    );
    expect(md).toBe(
      '**bold** and *italic* and ~~gone~~ and `cmd` and [docs](https://example.com)',
    );
  });

  it('code mark wins over styling marks and links wrap styled text', () => {
    const md = tiptapDocToMarkdown(
      doc(
        paragraph(
          text('snippet', [{ type: 'code' }, { type: 'bold' }]),
          text(' '),
          text('label', [
            { type: 'bold' },
            { type: 'link', attrs: { href: '/x' } },
          ]),
        ),
      ),
    );
    expect(md).toBe('`snippet` [**label**](/x)');
  });

  it('renders bullet, ordered (with start) and task lists', () => {
    const item = (t: string): TiptapNode => ({
      type: 'listItem',
      content: [paragraph(text(t))],
    });
    const md = tiptapDocToMarkdown(
      doc(
        { type: 'bulletList', content: [item('one'), item('two')] },
        { type: 'orderedList', attrs: { start: 3 }, content: [item('three'), item('four')] },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('done'))] },
            { type: 'taskItem', attrs: { checked: false }, content: [paragraph(text('todo'))] },
          ],
        },
      ),
    );
    expect(md).toBe(
      ['- one', '- two', '', '3. three', '4. four', '', '- [x] done', '- [ ] todo'].join('\n'),
    );
  });

  it('indents nested lists under their parent item', () => {
    const md = tiptapDocToMarkdown(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              paragraph(text('parent')),
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [paragraph(text('child'))] },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(md).toBe('- parent\n\n  - child');
  });

  it('renders fenced code blocks with language and no mark processing', () => {
    const md = tiptapDocToMarkdown(
      doc({
        type: 'codeBlock',
        attrs: { language: 'bash' },
        content: [text('echo "**not bold**"')],
      }),
    );
    expect(md).toBe('```bash\necho "**not bold**"\n```');
  });

  it('renders blockquotes line-by-line', () => {
    const md = tiptapDocToMarkdown(
      doc({
        type: 'blockquote',
        content: [paragraph(text('first')), paragraph(text('second'))],
      }),
    );
    expect(md).toBe('> first\n>\n> second');
  });

  it('renders GFM tables and promotes the first row to a header', () => {
    const cell = (t: string, header = false): TiptapNode => ({
      type: header ? 'tableHeader' : 'tableCell',
      content: [paragraph(text(t))],
    });
    const md = tiptapDocToMarkdown(
      doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('Host', true), cell('IP', true)] },
          { type: 'tableRow', content: [cell('web-1'), cell('10.0.0.2')] },
        ],
      }),
    );
    expect(md).toBe(
      ['| Host | IP |', '| --- | --- |', '| web-1 | 10.0.0.2 |'].join('\n'),
    );
  });

  it('escapes pipes and joins multi-paragraph cells with <br>', () => {
    const md = tiptapDocToMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [paragraph(text('a|b')), paragraph(text('second'))],
              },
            ],
          },
        ],
      }),
    );
    expect(md).toBe(['| a\\|b<br>second |', '| --- |'].join('\n'));
  });

  it('renders images, horizontal rules and hard breaks', () => {
    const md = tiptapDocToMarkdown(
      doc(
        paragraph(text('above'), { type: 'hardBreak' }, text('below')),
        { type: 'horizontalRule' },
        { type: 'image', attrs: { src: '/img.png', alt: 'diagram' } },
      ),
    );
    expect(md).toBe('above  \nbelow\n\n---\n\n![diagram](/img.png)');
  });

  it('renders mentions/internal links as their label', () => {
    const md = tiptapDocToMarkdown(
      doc(
        paragraph(
          text('see '),
          { type: 'internalLink', attrs: { label: 'VPN Setup' } },
        ),
      ),
    );
    expect(md).toBe('see VPN Setup');
  });

  it('degrades unknown node types to their plaintext content', () => {
    const md = tiptapDocToMarkdown(
      doc({
        type: 'weirdExtension',
        content: [paragraph(text('still visible'))],
      }),
    );
    expect(md).toBe('still visible');
  });
});
