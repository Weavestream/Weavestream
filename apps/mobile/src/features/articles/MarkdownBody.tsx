import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ProseLink } from '../../components/richtext/ProseLink';
import { ProseImg } from '../../components/richtext/ProseImg';

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
 */
export function MarkdownBody({ source }: { source: string }) {
  return (
    <div className="m-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

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
