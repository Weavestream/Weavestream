import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { safeProseHref } from '@weavestream/shared';
import { str } from './attr';

/**
 * The ONE anchor policy for user-stored prose, used by both render
 * paths (the Tiptap walker and react-markdown's `a` override). Never
 * render a stored href raw.
 *
 *  - `safeProseHref` gates everything: same-origin paths, fragments,
 *    queries, and dot-relative forms pass verbatim; http/https pass;
 *    `javascript:`/`data:`/control-char smuggles are rejected.
 *  - A rejected href renders the children as plain text — including
 *    `mailto:`/`tel:`, which is the app-wide policy (same treatment as
 *    password URL rows). Don't "fix" that here.
 *  - Pure-fragment hrefs (`#fn-1`) stay same-tab with no target/rel:
 *    remark-gfm footnotes and their backlinks must scroll within the
 *    current article, and a same-document fragment gains nothing from
 *    a new tab.
 *  - Everything else opens in a new tab — leaving the PWA shell
 *    in-tab is worse than a tab switch, and same-origin targets are
 *    desktop routes anyway.
 *
 * `rest` carries the renderer's own anchor attributes through — GFM
 * footnotes are dead without them (`id="user-content-fnref-*"` is the
 * backlink target; `aria-describedby`/`data-footnote-*` are the a11y
 * wiring). With raw HTML dropped in both paths, these attrs are
 * library-generated, never author-controlled — remark-gfm's
 * `user-content-` clobber prefix guards the id namespace. The spread
 * comes FIRST so the policy attributes (href, and target/rel on both
 * branches) always win over anything a future caller passes.
 */
type ProseLinkProps = {
  href: unknown;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'children'>;

export function ProseLink({ href, children, ...rest }: ProseLinkProps) {
  const raw = str(href);
  const safe = raw === null ? null : safeProseHref(raw);
  // Keep id/title/aria on the neutralized span so fragment targets
  // stay resolvable even when the href itself is rejected.
  if (safe === null) return <span {...rest}>{children}</span>;
  if (safe.startsWith('#')) {
    return (
      <a {...rest} href={safe} target={undefined} rel={undefined}>
        {children}
      </a>
    );
  }
  return (
    <a {...rest} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
