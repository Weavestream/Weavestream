/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MarkdownBody } from './MarkdownBody';

describe('MarkdownBody raw-HTML neutralization (no rehype-raw, ever)', () => {
  it('never renders a script element from stored markdown', () => {
    const { container } = render(
      <MarkdownBody source={'before\n\n<script>alert(1)</script>\n\nafter'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
  });

  it('never renders an img element from raw HTML in markdown', () => {
    const { container } = render(
      <MarkdownBody source={'x <img src=x onerror=alert(1)> y'} />,
    );
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('MarkdownBody links', () => {
  it('drops javascript: links to plain text', () => {
    const { container } = render(
      <MarkdownBody source={'[click me](javascript:alert(1))'} />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('click me')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('keeps rooted same-origin links verbatim, opening in a new tab', () => {
    const { container } = render(<MarkdownBody source={'[docs](/docs/x)'} />);
    const a = container.querySelector('a')!;
    expect(a).toHaveAttribute('href', '/docs/x');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps fragment links same-tab for footnote navigation', () => {
    const { container } = render(<MarkdownBody source={'[note](#fn-1)'} />);
    const a = container.querySelector('a')!;
    expect(a).toHaveAttribute('href', '#fn-1');
    expect(a).not.toHaveAttribute('target');
    expect(a).not.toHaveAttribute('rel');
  });

  it('gives external links rel/target and promotes scheme-less hosts', () => {
    const { container } = render(
      <MarkdownBody source={'[a](https://example.com/x) and [b](portal.example.com)'} />,
    );
    const anchors = container.querySelectorAll('a');
    expect(anchors[0]).toHaveAttribute('href', 'https://example.com/x');
    expect(anchors[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(anchors[1]).toHaveAttribute('href', 'https://portal.example.com/');
  });
});

describe('MarkdownBody images (ProseImg gate)', () => {
  it('renders same-origin upload images', () => {
    const { container } = render(
      <MarkdownBody source={'![plate](/api/v1/companies/c/uploads/u/image)'} />,
    );
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', '/api/v1/companies/c/uploads/u/image');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('drops javascript: image sources to alt text', () => {
    const { container } = render(
      <MarkdownBody source={'![diagram](javascript:alert(1))'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('diagram')).toBeInTheDocument();
  });

  it('drops mailto: image sources', () => {
    const { container } = render(<MarkdownBody source={'![m](mailto:a@b.example)'} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('never emits a scheme-relative src from a /\\host source', () => {
    // micromark percent-encodes the backslash in the destination
    // (`/%5Cevil.com`), which a browser resolves as a literal same-origin
    // PATH — the encoding is itself the neutralization. The invariant is
    // that no src can start with `//` or `/\`, the two shapes browsers
    // reinterpret as an authority. (The Tiptap walker sees the raw
    // attr value instead; safeProseHref classifies it external there.)
    const { container } = render(<MarkdownBody source={'![x](/\\evil.com)'} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    const src = img!.getAttribute('src')!;
    expect(src.startsWith('//')).toBe(false);
    expect(src.startsWith('/\\')).toBe(false);
  });
});

describe('MarkdownBody GFM', () => {
  it('renders tables inside the horizontal-scroll wrapper', () => {
    const { container } = render(
      <MarkdownBody source={'| Host | IP |\n| --- | --- |\n| rtr1 | 10.0.0.1 |'} />,
    );
    const wrap = container.querySelector('.m-prose-tablewrap')!;
    expect(wrap.querySelector('table th')).toHaveTextContent('Host');
    expect(wrap.querySelector('table td')).toHaveTextContent('rtr1');
  });

  it('renders task-list checkboxes disabled', () => {
    const { container } = render(
      <MarkdownBody source={'- [x] patched\n- [ ] rebooted'} />,
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).not.toBeChecked();
  });

  it('round-trips a real footnote: reference id, backlink target, a11y wiring', () => {
    // A hand-written `[note](#fn-1)` cannot catch a dropped `id` — only
    // remark-gfm's actual output proves the backlink has a live target.
    const { container } = render(
      <MarkdownBody source={'Reboot the router.[^1]\n\n[^1]: Only after hours.'} />,
    );

    const ref = container.querySelector('sup a')!;
    expect(ref).toHaveAttribute('href', '#user-content-fn-1');
    expect(ref).toHaveAttribute('id', 'user-content-fnref-1');
    expect(ref).toHaveAttribute('aria-describedby', 'footnote-label');
    expect(ref).not.toHaveAttribute('target');

    // The footnote body exists and its backlink points back at the
    // reference — and that target must actually exist in the DOM.
    expect(container.querySelector('li#user-content-fn-1')).not.toBeNull();
    const backref = container.querySelector('a[data-footnote-backref]')!;
    expect(backref).toHaveAttribute('href', '#user-content-fnref-1');
    expect(container.querySelector('#user-content-fnref-1')).toBe(ref);
  });

  it('renders fenced code blocks without wrapping markup', () => {
    const { container } = render(
      <MarkdownBody source={'```bash\nssh admin@10.0.0.1 **not bold**\n```'} />,
    );
    const code = container.querySelector('pre code')!;
    expect(code).toHaveTextContent('ssh admin@10.0.0.1 **not bold**');
    expect(code.querySelector('strong')).toBeNull();
  });
});
