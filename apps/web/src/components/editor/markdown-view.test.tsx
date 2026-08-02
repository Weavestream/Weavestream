/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { MarkdownView } from './markdown-view';

const copyToClipboard = jest.fn();

jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

// Routing is what this file tests. The block's own behaviour — shadow
// root, staleness, last-good — is `mermaid-block.test.tsx`; stubbing it
// here also keeps `mermaid` out of this suite's module graph entirely.
jest.mock('./mermaid-block', () => ({
  MermaidBlock: ({ source }: { source: string }) => (
    <div data-testid="mermaid" data-source={source} />
  ),
}));

/**
 * The desktop half of the markdown-renderer guard. `apps/mobile`'s
 * `MarkdownBody.test.tsx` has pinned raw-HTML neutralization since Phase
 * 2b; this side had no test at all until the diagram work needed one,
 * which meant the *same* invariant was enforced on one surface only.
 *
 * **Never add `rehype-raw`.** react-markdown drops raw-HTML nodes by
 * default, and that is the neutralization CLAUDE.md §3 requires of
 * stored article content — every article body is authored by an MSP
 * admin and rendered to client-portal users, so passthrough would turn
 * every runbook into a cross-tenant XSS vector. These tests lock it in.
 */

function view(source: string) {
  const { container } = render(<MarkdownView source={source} />);
  return container;
}

describe('raw-HTML neutralization', () => {
  it('never executes or emits a <script> from article source', () => {
    const container = view('Before\n\n<script>alert(1)</script>\n\nAfter');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('After');
  });

  it('never emits an <img> carrying an inline handler', () => {
    const container = view('<img src=x onerror="alert(1)">');
    expect(container.querySelector('img')).toBeNull();
  });

  it('never emits an <iframe>', () => {
    const container = view('<iframe src="https://evil.example"></iframe>');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('escapes raw HTML into inert text rather than deleting it', () => {
    // The neutralization is *escaping*, not stripping: the markup shows
    // up as literal characters the reader can see. Asserting the absence
    // of the substring would be testing the wrong property and would
    // pass just as happily against a renderer that silently dropped
    // author content.
    const container = view('<b>shown as text</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>shown as text</b>');
  });
});

describe('GFM support', () => {
  it('renders tables', () => {
    const container = view(['| Host | Role |', '| --- | --- |', '| db-1 | primary |'].join('\n'));
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).toContain('primary');
  });

  it('renders task lists', () => {
    const container = view('- [x] promoted\n- [ ] fenced');
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
  });

  it('renders strikethrough', () => {
    expect(view('~~gone~~').querySelector('del')).not.toBeNull();
  });
});

describe('code blocks', () => {
  it('renders a fenced block as <pre><code> with the language class', () => {
    const container = view('```bash\npg_ctl promote -D /data\n```');
    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code).toHaveClass('language-bash');
    expect(code?.textContent).toBe('pg_ctl promote -D /data\n');
  });

  it('copies fenced code and reports success', async () => {
    copyToClipboard.mockResolvedValueOnce(true);
    const container = view('```bash\nprintf "ready\\n"\n```');
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');

    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('');
    expect(button).toHaveAttribute('data-copy-state', 'idle');
    fireEvent.click(button!);

    await waitFor(() => expect(button).toHaveAttribute('aria-label', 'Code copied'));
    expect(button).toHaveAttribute('data-copy-state', 'copied');
    expect(copyToClipboard).toHaveBeenCalledWith('printf "ready\\n"');
  });

  it('reports a failed clipboard write', async () => {
    copyToClipboard.mockResolvedValueOnce(false);
    const container = view('```\nrestricted\n```');
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');

    fireEvent.click(button!);

    await waitFor(() => expect(button).toHaveAttribute('aria-label', 'Copy failed'));
    expect(button).toHaveAttribute('data-copy-state', 'failed');
  });

  it('leaves markup inside a fence unprocessed', () => {
    const container = view('```\n**not bold**\n```');
    expect(container.querySelector('pre strong')).toBeNull();
    expect(container.textContent).toContain('**not bold**');
  });

  it('renders inline code as <code> with no language class', () => {
    const container = view('run `mermaid` locally');
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('mermaid');
    expect(code?.className).toBe('');
    expect(container.querySelector('button[aria-label="Copy code"]')).toBeNull();
  });
});

describe('mermaid fence routing', () => {
  const DIAGRAM = ['flowchart TD', '  A[Start] -->|go| B{Check}', '  B --> C'].join('\n');

  it('routes a ```mermaid fence to MermaidBlock with the exact source', () => {
    const container = view('```mermaid\n' + DIAGRAM + '\n```');
    const block = container.querySelector('[data-testid="mermaid"]');
    expect(block).not.toBeNull();
    expect(block?.getAttribute('data-source')).toBe(DIAGRAM);
    // The <pre> is replaced, not wrapped — flow content inside <pre> is
    // invalid HTML and would warn on hydration.
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('button[aria-label="Copy code"]')).toBeNull();
  });

  it.each([
    ['a plain fence', '```\nflowchart TD\n```'],
    ['another language', '```bash\nflowchart TD\n```'],
    ['a language that merely starts the same', '```mermaidjs\nflowchart TD\n```'],
    ['a differently-cased language', '```Mermaid\nflowchart TD\n```'],
  ])('leaves %s as an ordinary code block', (_label, source) => {
    // The class match is exact and case-sensitive on purpose: guessing
    // at near-misses is how a renderer starts executing things the
    // author did not ask it to.
    const container = view(source);
    expect(container.querySelector('[data-testid="mermaid"]')).toBeNull();
    expect(container.querySelector('pre')).not.toBeNull();
  });

  it('never routes inline code', () => {
    const container = view('use `mermaid` here');
    expect(container.querySelector('[data-testid="mermaid"]')).toBeNull();
  });

  it('routes fences nested in a list item and in a blockquote', () => {
    const inList = view('- step one\n\n  ```mermaid\n  flowchart TD\n  ```');
    expect(inList.querySelector('[data-testid="mermaid"]')).not.toBeNull();

    const inQuote = view('> ```mermaid\n> flowchart TD\n> ```');
    expect(inQuote.querySelector('[data-testid="mermaid"]')).not.toBeNull();
  });

  it('renders several diagrams in one article', () => {
    const container = view(
      '```mermaid\nflowchart TD\n  A --> B\n```\n\ntext\n\n```mermaid\npie\n  "a" : 1\n```',
    );
    expect(container.querySelectorAll('[data-testid="mermaid"]')).toHaveLength(2);
  });
});
