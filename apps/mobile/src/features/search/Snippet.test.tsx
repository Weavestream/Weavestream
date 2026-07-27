/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { Snippet } from './Snippet';

describe('Snippet', () => {
  it('renders <mark> sentinels as real mark elements', () => {
    const { container } = render(
      <Snippet snippet="router at <mark>pines</mark> lodge" />,
    );
    const mark = container.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('pines');
    expect(container.textContent).toBe('router at pines lodge');
  });

  it('keeps server-escaped markup inert text — never parsed as HTML', () => {
    // JS string literal, NOT a JSX attribute string — JSX would decode
    // the entities before the component ever saw them.
    const { container } = render(
      <Snippet
        snippet={'safe &lt;script&gt;alert(1)&lt;/script&gt; <mark>x</mark>'}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    // Decoded for display as TEXT — React escapes it on render.
    expect(container.textContent).toBe('safe <script>alert(1)</script> x');
  });

  it('decodes the three server entities, ampersand last', () => {
    const { container } = render(
      <Snippet snippet={'AT&amp;T &amp;lt;literal&amp;gt;'} />,
    );
    // "&amp;T" → "&T"; a source-literal "&lt;" (escaped to "&amp;lt;")
    // survives as "&lt;", not "<".
    expect(container.textContent).toBe('AT&T &lt;literal&gt;');
  });

  it('renders a plain snippet unchanged', () => {
    const { container } = render(<Snippet snippet="no highlights here" />);
    expect(container.textContent).toBe('no highlights here');
    expect(container.querySelector('mark')).toBeNull();
  });
});
