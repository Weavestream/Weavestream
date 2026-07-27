import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react';
import { safeProseHref } from '@weavestream/shared';
import {
  desktopRecordLink,
  type DesktopRecordLink,
} from '../../lib/desktop-links';
import { useCurrentOrgIdOrNull } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
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
 *  - A desktop record URL for the ACTIVE org (`/admin/companies/…/
 *    {articles|assets|passwords}/{id}` — the shapes the Ask model
 *    cites and authors paste) re-targets to the mobile detail screen
 *    and navigates in-app: a citation tap must not dump a technician
 *    into the desktop view, and SPA navigation is what keeps the Ask
 *    transcript alive while the overlay closes. Cross-org record URLs
 *    stay desktop links — the mobile screen would 404 under the
 *    current scope; the desktop view can render them.
 *  - Everything else opens in a new tab — leaving the PWA shell
 *    in-tab is worse than a tab switch, and the remaining same-origin
 *    targets are desktop-only routes.
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
  const record = desktopRecordLink(safe);
  if (record) {
    // Its own component so the hooks it needs (org scope, the stamped
    // navigate) only mount for record links — plain/external links
    // keep rendering without any provider, exactly as before.
    return (
      <RecordLink {...rest} record={record} desktopHref={safe}>
        {children}
      </RecordLink>
    );
  }
  return (
    <a {...rest} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function RecordLink({
  record,
  desktopHref,
  children,
  ...rest
}: {
  record: DesktopRecordLink;
  desktopHref: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'children'>) {
  // Non-throwing on purpose — and the ONLY hook allowed at this level:
  // `useScopedNavigate` throws outside OrgProvider (it reads the org
  // for the history stamp), so it lives in the child below, which
  // mounts only after the org matched — i.e. only inside the app tree.
  const orgId = useCurrentOrgIdOrNull();

  if (orgId === null || orgId !== record.companyId) {
    // Cross-org (or unscoped): keep the desktop link — the mobile
    // detail screen fetches under the CURRENT org and would 404.
    return (
      <a {...rest} href={desktopHref} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  return (
    <InAppRecordLink {...rest} to={record.to}>
      {children}
    </InAppRecordLink>
  );
}

function InAppRecordLink({
  to,
  children,
  ...rest
}: {
  to: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'children'>) {
  const navigate = useScopedNavigate();

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Modified/middle clicks keep the browser's own behavior against
    // the real `/m/...` href (new tab boots the SPA at the record).
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    // No `upIsBack`: prose is not the record's structural parent, so
    // the detail's chevron falls back structurally (honest label).
    // From the Ask overlay this also drops `?sheet=ask` — the panel
    // closes, the transcript survives in its provider.
    navigate({ to });
  };

  return (
    <a {...rest} href={`/m${to}`} onClick={onClick}>
      {children}
    </a>
  );
}
