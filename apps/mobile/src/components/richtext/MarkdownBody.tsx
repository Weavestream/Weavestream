import { useMemo, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mermaidSourceFromPre } from '@weavestream/shared';
import { ProseLink } from './ProseLink';
import { ProseImg } from './ProseImg';
import { MermaidBlock } from './MermaidBlock';

/**
 * Reader for `editorMode: 'markdown'` articles — the same
 * react-markdown + remark-gfm pair the desktop uses, inside the shared
 * `.m-prose` typography block so both article formats render
 * identically.
 *
 * **Never add `rehype-raw`.** react-markdown drops raw-HTML nodes by
 * default, which is the neutralization CLAUDE.md §3 requires of stored
 * article content; enabling passthrough turns every runbook into an
 * XSS vector. The MarkdownBody tests lock this in.
 *
 * Overrides are behaviour-only (styling lives in `.m-prose` CSS):
 *  - `a`/`img` route through the SAME `ProseLink`/`ProseImg` policy as
 *    the Tiptap walker — one href/src gate for both render paths.
 *    react-markdown's default `urlTransform` still runs underneath as
 *    belt-and-braces; the components are the enforced gate.
 *  - The `a` override forwards react-markdown's OWN anchor attributes
 *    (everything but the hast `node`). GFM footnotes depend on them:
 *    the reference's `id="user-content-fnref-*"` is what the backlink
 *    targets, and `aria-describedby`/`data-footnote-*` are the a11y
 *    wiring. Raw HTML is dropped (above), so these attrs are always
 *    renderer-generated — an author cannot smuggle attributes here,
 *    and ProseLink re-asserts href/target/rel after the spread.
 *  - `table` gains the horizontal-scroll wrapper; without it one wide
 *    GFM table makes the whole Screen scroll sideways.
 *  - `pre` routes a ```mermaid fence to `MermaidBlock`, but ONLY when
 *    the caller opts in — see `diagrams` below.
 */
export function MarkdownBody({
  source,
  diagrams = false,
}: {
  source: string;
  /**
   * Render ```mermaid fences as diagrams. Default OFF, and the default
   * is what keeps the Ask transcript out of scope: this component has
   * two call sites, and in `Transcript` the source is a partially
   * streamed answer, so a half-typed fence would throw on nearly every
   * SSE token. `ArticleBodyView` is the only caller that passes `true`.
   */
  diagrams?: boolean;
}) {
  // Stable identity: react-markdown rebuilds the whole tree when
  // `components` changes, remounting every diagram.
  const components = useMemo(
    () => (diagrams ? { ...COMPONENTS, pre: MermaidPre } : COMPONENTS),
    [diagrams],
  );

  return (
    <div className="m-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Overrides `pre`, not `code`: react-markdown v10 removed the `inline`
 * prop, so a `code` override cannot tell a fence from an inline span
 * without reading the hast node anyway — and returning a `<figure>` from
 * it would nest flow content inside `<pre>`, which is invalid HTML.
 *
 * `mermaidSourceFromPre` is the SHARED rule (`@weavestream/shared`), not
 * a local copy: desktop, mobile and the PDF export all have to agree on
 * what counts as a diagram. It reads the hast tree react-markdown built,
 * never raw HTML, so the "never add `rehype-raw`" posture above is
 * untouched.
 */
const MermaidPre: NonNullable<
  ComponentProps<typeof ReactMarkdown>['components']
>['pre'] = ({ node, children, ...rest }) => {
  const source = mermaidSourceFromPre(node);
  return source === null ? <pre {...rest}>{children}</pre> : <MermaidBlock source={source} />;
};

const COMPONENTS: ComponentProps<typeof ReactMarkdown>['components'] = {
  a: ({ node: _node, href, children, ...rest }) => (
    <ProseLink href={href} {...rest}>
      {children}
    </ProseLink>
  ),
  img: ({ src, alt, title }) => <ProseImg src={src} alt={alt} title={title} />,
  table: ({ children }) => (
    <div className="m-prose-tablewrap">
      <table>{children}</table>
    </div>
  ),
};
