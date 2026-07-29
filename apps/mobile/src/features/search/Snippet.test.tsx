/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { HighlightMatches, Snippet } from './Snippet';

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


describe('queryTokens / HighlightMatches — websearch operator surface (5b)', () => {
  const { queryTokens, queryGroups, titleCoversQuery } = jest.requireActual(
    './Snippet',
  ) as {
    queryTokens: (q: string) => string[];
    queryGroups: (q: string) => string[][];
    titleCoversQuery: (t: string, q: string) => boolean;
  };

  it('drops the OR operator instead of highlighting "or" inside words', () => {
    expect(queryTokens('fortinet OR cisco')).toEqual(['fortinet', 'cisco']);
    render(<HighlightMatches text="Fortinet firewall" query="fortinet OR cisco" />);
    const marks = document.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('Fortinet');
  });

  it('treats a quoted phrase as ONE token, quotes stripped', () => {
    expect(queryTokens('"serial number" rack')).toEqual(['serial number', 'rack']);
    render(<HighlightMatches text="The serial number label" query={'"serial number"'} />);
    expect(document.querySelector('mark')).toHaveTextContent('serial number');
  });

  it('never highlights an excluded (-term) — it cannot occur in results', () => {
    expect(queryTokens('router -fortinet')).toEqual(['router']);
    render(<HighlightMatches text="Fortinet router" query="router -fortinet" />);
    const marks = document.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('router');
  });

  it('excludes a NEGATED PHRASE whole — never resurrecting its tail as a term', () => {
    // `-"serial number"`: the tail must not come back as a positive
    // `number` token, or the row highlights excluded text.
    expect(queryTokens('-"serial number" rack')).toEqual(['rack']);
    render(<HighlightMatches text="Rack serial number 42" query={'-"serial number" rack'} />);
    const marks = document.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('Rack');
  });

  it('treats an unbalanced quote leniently, as an ordinary word', () => {
    expect(queryTokens('"serial')).toEqual(['serial']);
  });

  it('parses OR precedence as groups: `a b OR c` = (a AND b) OR (c)', () => {
    expect(queryGroups('fortinet vpn OR cisco')).toEqual([
      ['fortinet', 'vpn'],
      ['cisco'],
    ]);
    // A dangling operator produces no empty group.
    expect(queryGroups('fortinet OR')).toEqual([['fortinet']]);
  });

  it('titleCoversQuery: ALL terms within a group, ANY group', () => {
    // Every token present ⇒ the title explains the whole match.
    expect(titleCoversQuery('Fortinet firewall', 'fortinet')).toBe(true);
    expect(titleCoversQuery('Fortinet VPN guide', 'fortinet vpn')).toBe(true);
    // Only half present ⇒ the body still owes an explanation for "vpn".
    expect(titleCoversQuery('Fortinet router', 'fortinet vpn')).toBe(false);
    expect(titleCoversQuery('Runbook', 'fortinet')).toBe(false);
    // No positive tokens, or a stem-only server match: show the snippet.
    expect(titleCoversQuery('anything', '-only -excluded')).toBe(false);
    expect(titleCoversQuery('Configuration guide', 'configuring')).toBe(false);
    // OR: one satisfied branch fully explains the row.
    expect(titleCoversQuery('Fortinet firewall', 'fortinet OR cisco')).toBe(true);
    expect(titleCoversQuery('Cisco switch', 'fortinet OR cisco')).toBe(true);
    expect(titleCoversQuery('Juniper switch', 'fortinet OR cisco')).toBe(false);
    // …but a multi-term branch still needs all of ITS terms.
    expect(titleCoversQuery('Fortinet router', 'fortinet vpn OR cisco')).toBe(false);
    expect(titleCoversQuery('Rack label', '-"serial number" rack')).toBe(true);
  });
});
