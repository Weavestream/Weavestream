/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { TiptapView } from './TiptapView';

function doc(content: unknown[]) {
  return { type: 'doc', content };
}
function para(...content: unknown[]) {
  return { type: 'paragraph', content };
}
function text(t: string, marks?: unknown[]) {
  return { type: 'text', text: t, ...(marks ? { marks } : {}) };
}

describe('TiptapView structure', () => {
  it('renders paragraphs with nested marks, link outermost', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          para(
            text('styled', [
              { type: 'bold' },
              { type: 'italic' },
              { type: 'link', attrs: { href: 'https://example.com/x' } },
            ]),
          ),
        ])}
      />,
    );
    const a = container.querySelector('a')!;
    expect(a).toHaveAttribute('href', 'https://example.com/x');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    // link wraps the styled run: a > em > strong > 'styled'
    expect(a.querySelector('em strong')).toHaveTextContent('styled');
  });

  it('clamps heading levels into 1–6', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          { type: 'heading', attrs: { level: 9 }, content: [text('nine')] },
          { type: 'heading', attrs: { level: 0 }, content: [text('zero')] },
          { type: 'heading', attrs: { level: {} }, content: [text('garbage')] },
          { type: 'heading', attrs: { level: 2 }, content: [text('two')] },
        ])}
      />,
    );
    expect(container.querySelector('h6')).toHaveTextContent('nine');
    expect(container.querySelectorAll('h1')).toHaveLength(2); // clamped 0 + garbage
    expect(container.querySelector('h2')).toHaveTextContent('two');
  });

  it('renders ordered list start (bounded) and bullet lists', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          {
            type: 'orderedList',
            attrs: { start: 4 },
            content: [{ type: 'listItem', content: [para(text('four'))] }],
          },
          {
            type: 'orderedList',
            attrs: { start: -5 },
            content: [{ type: 'listItem', content: [para(text('clamped'))] }],
          },
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [para(text('dot'))] }],
          },
        ])}
      />,
    );
    const ols = container.querySelectorAll('ol');
    expect(ols[0]).toHaveAttribute('start', '4');
    expect(ols[1]).toHaveAttribute('start', '1');
    expect(container.querySelector('ul li')).toHaveTextContent('dot');
  });

  it('renders nested task lists with checked, disabled checkboxes', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { checked: true },
                content: [
                  para(text('done')),
                  {
                    type: 'taskList',
                    content: [
                      {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [para(text('nested todo'))],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])}
      />,
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).not.toBeChecked();
    expect(screen.getByText('nested todo')).toBeInTheDocument();
  });

  it('renders tables inside the scroll wrapper, rows in a tbody, spans mapped', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableHeader',
                    attrs: { colspan: 2, rowspan: 3 },
                    content: [para(text('Head'))],
                  },
                  { type: 'tableCell', content: [para(text('Cell'))] },
                ],
              },
            ],
          },
        ])}
      />,
    );
    const wrap = container.querySelector('.m-prose-tablewrap')!;
    expect(wrap.querySelector('table tbody tr')).not.toBeNull();
    const th = wrap.querySelector('th')!;
    expect(th).toHaveAttribute('colspan', '2');
    expect(th).toHaveAttribute('rowspan', '3');
    expect(wrap.querySelector('td')).toHaveTextContent('Cell');
  });

  it('clamps absurd spans so one cell cannot distort the layout', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  { type: 'tableCell', attrs: { colspan: 99999 }, content: [para(text('x'))] },
                ],
              },
            ],
          },
        ])}
      />,
    );
    expect(container.querySelector('td')).toHaveAttribute('colspan', '1000');
  });

  it('renders code blocks as raw text without mark elements', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          {
            type: 'codeBlock',
            attrs: { language: 'bash' },
            content: [text('ssh admin@10.0.0.1 **not bold**')],
          },
        ])}
      />,
    );
    const code = container.querySelector('pre code')!;
    expect(code).toHaveTextContent('ssh admin@10.0.0.1 **not bold**');
    expect(code).toHaveAttribute('data-language', 'bash');
    expect(code.querySelector('strong')).toBeNull();
  });

  it('renders hardBreak and horizontalRule', () => {
    const { container } = render(
      <TiptapView
        doc={doc([para(text('a'), { type: 'hardBreak' }, text('b')), { type: 'horizontalRule' }])}
      />,
    );
    expect(container.querySelector('p br')).not.toBeNull();
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders unknown nodes through to their children, drops childless ones, ignores unknown marks', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          { type: 'futureBlock', content: [para(text('survives'))] },
          { type: 'futureLeaf' },
          para(text('marked', [{ type: 'sparkles' }])),
        ])}
      />,
    );
    expect(screen.getByText('survives')).toBeInTheDocument();
    expect(screen.getByText('marked')).toBeInTheDocument();
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });
});

describe('TiptapView malformed content (never crash)', () => {
  it('skips null and primitive entries in content arrays', () => {
    render(
      <TiptapView doc={doc([null, 42, 'stray', para(text('kept'))])} />,
    );
    expect(screen.getByText('kept')).toBeInTheDocument();
  });

  it('drops non-string text, non-array marks, and object mention labels', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          para({ type: 'text', text: 123 }),
          para({ type: 'text', text: 'ok', marks: 'nope' }),
          para({ type: 'mention', attrs: { kind: 'article', label: {} } }),
        ])}
      />,
    );
    expect(screen.getByText('ok')).toBeInTheDocument();
    // Object-valued label renders the fallback, not [object Object].
    expect(container.querySelector('.m-mention')).toHaveTextContent('—');
  });

  it('renders a doc with attrs missing entirely', () => {
    render(
      <TiptapView
        doc={doc([
          { type: 'heading', content: [text('no attrs')] },
          { type: 'orderedList', content: [{ type: 'listItem', content: [para(text('li'))] }] },
        ])}
      />,
    );
    expect(screen.getByText('no attrs')).toBeInTheDocument();
  });
});

describe('TiptapView link and image safety', () => {
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,hi'],
    ['java\tscript:alert(1)'],
  ])('renders %s link marks as plain text with no anchor', (href) => {
    const { container } = render(
      <TiptapView doc={doc([para(text('click me', [{ type: 'link', attrs: { href } }]))])} />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('click me')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('script:');
  });

  it('keeps rooted same-origin hrefs verbatim (new tab) and fragments same-tab', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          para(text('path', [{ type: 'link', attrs: { href: '/docs/x' } }])),
          para(text('footnote', [{ type: 'link', attrs: { href: '#fn-1' } }])),
        ])}
      />,
    );
    const anchors = container.querySelectorAll('a');
    expect(anchors[0]).toHaveAttribute('href', '/docs/x');
    expect(anchors[0]).toHaveAttribute('target', '_blank');
    expect(anchors[1]).toHaveAttribute('href', '#fn-1');
    expect(anchors[1]).not.toHaveAttribute('target');
    expect(anchors[1]).not.toHaveAttribute('rel');
  });

  it('promotes scheme-less hrefs to https with rel/target', () => {
    const { container } = render(
      <TiptapView
        doc={doc([para(text('portal', [{ type: 'link', attrs: { href: 'portal.example.com' } }]))])}
      />,
    );
    const a = container.querySelector('a')!;
    expect(a).toHaveAttribute('href', 'https://portal.example.com/');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders markup-looking text as literal text (React escaping)', () => {
    const { container } = render(
      <TiptapView doc={doc([para(text('<img src=x onerror=alert(1)>'))])} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('renders same-origin images with lazy loading and the persisted "320px" width', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          {
            type: 'image',
            attrs: {
              src: '/api/v1/companies/c1/uploads/u1/image',
              alt: 'serial plate',
              width: '320px',
            },
          },
        ])}
      />,
    );
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', '/api/v1/companies/c1/uploads/u1/image');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveStyle({ width: '320px' });
    expect(img).toHaveAttribute('alt', 'serial plate');
  });

  it('renders a rejected image src as alt text, no element', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          { type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'diagram' } },
        ])}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('diagram')).toBeInTheDocument();
  });
});

describe('TiptapView mentions', () => {
  it('renders mention and legacy internalLink as inert pills', () => {
    const { container } = render(
      <TiptapView
        doc={doc([
          para(
            { type: 'mention', attrs: { kind: 'password', label: 'Router admin', id: 'x' } },
            { type: 'internalLink', attrs: { kind: 'article', title: 'Reboot order' } },
          ),
        ])}
      />,
    );
    const pills = container.querySelectorAll('.m-mention');
    expect(pills[0]).toHaveTextContent('Router admin');
    expect(pills[1]).toHaveTextContent('Reboot order');
    // Inert in v1: no tappable role anywhere in the pill (44pt rule).
    expect(container.querySelector('.m-mention button')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('TiptapView legacy shapes', () => {
  it('renders the legacy { v, plain } wrapper through the normaliser', () => {
    render(<TiptapView doc={{ v: doc([para(text('legacy body'))]), plain: 'legacy body' }} />);
    expect(screen.getByText('legacy body')).toBeInTheDocument();
  });

  it('renders a bare-string value as a paragraph', () => {
    render(<TiptapView doc={'plain string value'} />);
    expect(screen.getByText('plain string value')).toBeInTheDocument();
  });

  it('renders garbage as an empty prose block without crashing', () => {
    const { container } = render(<TiptapView doc={{ bogus: true }} />);
    expect(container.querySelector('.m-prose')).not.toBeNull();
  });
});
