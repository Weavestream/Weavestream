'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { Icon, Kbd } from '../ui';
import { useSearchPalette } from '../search/search-palette-provider';
import { CompanyStickyNote } from './company-sticky-note';
import { useStickyNote } from './sticky-note-context';
import { useShellScope } from './shell-scope-context';
import { TopBarActions } from './top-bar-actions';

export type Crumb = {
  label: ReactNode;
  href?: string;
  mono?: boolean;
  /**
   * `pill` renders the crumb as a subtle bordered chip with a chevron
   * instead of plain breadcrumb text. Used for the scope control at
   * the head of the trail — the company name, pointing at the picker
   * (`/admin/companies`). A pill never gets a `/` after it: the chip's
   * own border already closes the segment, and a slash butted against
   * it just reads as noise.
   */
  variant?: 'pill';
  /**
   * Second segment of a `pill`, right of the company name behind a
   * hairline divider: the current section ("Passwords", "Assets", a
   * layout name), painted in the accent colour. Carried *inside* the
   * pill crumb rather than trailing it as a sibling so the grouping is
   * something the caller states, not something `TopBar` infers by
   * peeking at the next array entry. Ignored unless `variant: 'pill'`.
   */
  section?: { label: ReactNode; href?: string };
  /**
   * Tooltip. Worth setting on a pill, whose destination the label
   * alone doesn't reveal ("Acme Corp" → the company picker).
   */
  title?: string;
};

export function TopBar({
  crumbs = [],
  right,
  sub,
  subClassName,
}: {
  crumbs?: Crumb[];
  right?: ReactNode;
  sub?: ReactNode;
  /**
   * Optional class applied to the sub-row container. `PageHeader`
   * passes `page-header-sub` so the title/actions row stacks on
   * mobile (see `globals.css`).
   */
  subClassName?: string;
}) {
  // The per-company sticky note (when set) renders as the first row
  // INSIDE this sticky container, not as a separate sticky sibling —
  // two siblings with `top: 0` would overlap on scroll and the
  // breadcrumbs would slide behind the banner. Outside a CompanyShell
  // the context defaults to null and nothing renders.
  const stickyNote = useStickyNote();
  // Global action cluster (Expirations, Starred, Chat, Profile) lives
  // here so every authenticated page gets it without threading props
  // through `PageHeader`. `useShellScope()` returns `null` outside an
  // authenticated shell — in that case `TopBarActions` itself short-
  // circuits to `null` so the right slot stays empty (login, setup).
  const shellScope = useShellScope();
  // Search trigger mirrors the sidebar button — same palette, same
  // ⌘K hint — but sits in the header where the breadcrumb trail leaves
  // a wide dead zone. Gated on `shellScope` rather than on the palette
  // hook: `useSearchPalette()` deliberately returns a no-op context
  // outside a provider, so it can't tell us whether a palette actually
  // exists, and an inert search box on /login would be a lie.
  const palette = useSearchPalette();
  const showSearch = !!shellScope;
  return (
    <div
      style={{
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      {stickyNote ? (
        <CompanyStickyNote
          text={stickyNote.text}
          severity={stickyNote.severity}
        />
      ) : null}
      <div
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          gap: 10,
        }}
      >
        <div
          className="no-scrollbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            // Without a search box the trail owns the row, as before.
            // With one, the trail takes only what it needs — neither it
            // nor the search grows, and the slack goes to the auto
            // margin that pins the action cluster right.
            flex: showSearch ? '0 1 auto' : 1,
            minWidth: 0,
            // Long breadcrumb trails scroll horizontally on phones
            // instead of wrapping into a second row and pushing the
            // page-header title down. `whiteSpace: nowrap` forces the
            // inline children onto one line; overflow: auto keeps
            // that line scrubbable.
            whiteSpace: 'nowrap',
            overflowX: 'auto',
          }}
        >
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            // The pill is the head of the trail, so nothing precedes it
            // to separate from. Crumbs *after* it punctuate normally —
            // the chip already ends in the section name, and the slash
            // is what marks the descent into it.
            const separator = i > 0 && c.variant !== 'pill';
            if (c.variant === 'pill') {
              return (
                <ScopePill
                  key={i}
                  href={c.href}
                  title={c.title}
                  section={c.section}
                >
                  {c.label}
                </ScopePill>
              );
            }
            // Mono and sans glyphs have different intrinsic metrics, so
            // relying on flex `alignItems: center` leaves the mono crumb
            // visibly higher than its siblings. Pinning a shared
            // `lineHeight: 1` + `display: inline-flex` flattens each
            // label to exactly its font box so baselines line up.
            const node = (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: 12.5,
                  lineHeight: 1,
                  color: last ? 'var(--text)' : 'var(--muted)',
                  fontWeight: last ? 500 : 400,
                  fontFamily: c.mono ? 'var(--font-mono)' : 'var(--font-sans)',
                }}
              >
                {c.label}
              </span>
            );
            return (
              <Fragment key={i}>
                {separator && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: 'var(--faint)',
                      fontSize: 12.5,
                      lineHeight: 1,
                    }}
                  >
                    /
                  </span>
                )}
                {c.href && !last ? (
                  <a
                    href={c.href}
                    title={c.title}
                    style={{ display: 'inline-flex', alignItems: 'center' }}
                  >
                    {node}
                  </a>
                ) : (
                  node
                )}
              </Fragment>
            );
          })}
        </div>
        {showSearch && (
          <button
            type="button"
            onClick={palette.open}
            aria-label="Open search"
            className="topbar-chip hide-on-mobile"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 28,
              padding: '0 9px',
              // Resting skin is inline, not in `.topbar-chip` — see the
              // note on that class in `globals.css`. Longhand
              // `borderStyle`/`Width`/`Color` rather than the `border`
              // shorthand: a shorthand carrying a `var()` collapses
              // *entirely* to its initial values if the token ever
              // fails to resolve, and `border-style: none` means the
              // rule vanishes rather than merely losing its colour.
              borderStyle: 'solid',
              borderWidth: 1,
              borderColor: 'var(--line-2)',
              borderRadius: 'var(--radius-3)',
              background: 'var(--panel-2)',
              color: 'var(--dim)',
              // Never grows. A search field that stretches to fill the
              // row reads as the row's main subject; this one is a
              // shortcut sitting beside the trail, and the leftover
              // width belongs to the action cluster's right edge.
              flex: '0 1 220px',
              minWidth: 0,
              cursor: 'pointer',
            }}
          >
            <Icon.search size={12} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                textAlign: 'left',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Search everything
            </span>
            <Kbd>⌘K</Kbd>
          </button>
        )}
        {(right || shellScope) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              // Pins the cluster to the right edge. Neither the trail
              // nor the search box grows any more, so without this the
              // icons would trail the search box mid-row and drift with
              // the length of the company name.
              marginLeft: 'auto',
            }}
          >
            {right}
            {shellScope && <TopBarActions />}
          </div>
        )}
      </div>
      {sub && (
        <div
          className={subClassName}
          style={{
            padding: '0 20px 10px',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * The scope chip at the head of the trail: the company name with a
 * chevron, and — behind a hairline divider — the current section. The
 * company half navigates to the picker (`/admin/companies`), the same
 * contract the sidebar title block has always had, surfaced in the
 * header so the trail leads with *where you are* instead of a
 * "Companies" crumb that only ever pointed back at the list.
 *
 * The two halves are separate links rather than one chip-wide link,
 * for the same reason the sidebar splits its logo from its title: a
 * single outer link would make "Passwords" navigate to the company
 * picker, which is not what a click there means.
 *
 * Uses `next/link` (unlike the plain `<a>` crumbs around it) because
 * these are high-traffic controls and a full document reload is a
 * noticeably worse click. `prefetch={false}` matches the sidebar rule
 * — every prefetch of a dynamic `/admin/**` route costs a full SSR
 * render, and the shell is the omnipresent multiplier.
 */
function ScopePill({
  href,
  title,
  section,
  children,
}: {
  href?: string;
  title?: string;
  section?: { label: ReactNode; href?: string };
  children: ReactNode;
}) {
  const scopeBody = (
    <>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          // A long tenant name truncates rather than pushing the
          // section and the search box off the row.
          maxWidth: 200,
        }}
      >
        {children}
      </span>
      {href && (
        <Icon.chevronD
          size={12}
          style={{ color: 'var(--dim)', flexShrink: 0 }}
        />
      )}
    </>
  );
  // Each segment stretches the full chip height so its hover state
  // reads as a division of the chip rather than a floating swatch. The
  // container clips to its own border radius, which rounds the outer
  // corners of those hovers for free.
  const segment = {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'stretch',
    minWidth: 0,
    fontSize: 12.5,
    lineHeight: 1,
  } as const;
  const scopeStyle = {
    ...segment,
    gap: 5,
    // Tighter on the chevron side so the glyph doesn't float.
    padding: href ? '0 7px 0 10px' : '0 10px',
    color: 'var(--text)',
    fontWeight: 550,
  } as const;
  const sectionStyle = {
    ...segment,
    padding: '0 10px',
    color: 'var(--accent)',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 180,
  } as const;

  return (
    <span
      className="topbar-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        height: 28,
        minWidth: 0,
        overflow: 'hidden',
        // Same skin, same longhand reasoning as the search chip above.
        borderStyle: 'solid',
        borderWidth: 1,
        borderColor: 'var(--line-2)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--panel-2)',
      }}
    >
      {href ? (
        <Link
          href={href}
          title={title}
          prefetch={false}
          className="topbar-chip-seg"
          style={scopeStyle}
        >
          {scopeBody}
        </Link>
      ) : (
        <span style={scopeStyle}>{scopeBody}</span>
      )}
      {section && (
        <>
          <span
            aria-hidden
            style={{
              width: 1,
              alignSelf: 'stretch',
              background: 'var(--line)',
              flexShrink: 0,
            }}
          />
          {section.href ? (
            <Link
              href={section.href}
              prefetch={false}
              className="topbar-chip-seg"
              style={sectionStyle}
            >
              {section.label}
            </Link>
          ) : (
            <span style={sectionStyle}>{section.label}</span>
          )}
        </>
      )}
    </span>
  );
}
