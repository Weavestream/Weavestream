'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AppLogo, CompanyMark, Icon, type IconName } from '../ui';
import { useSidebarActiveOverride } from './sidebar-active';

export type SidebarItem = {
  id: string;
  label: string;
  href?: string;
  /**
   * Name of an icon in the shared `Icon` map. Must be a string (not a
   * component reference) so that server components can pass nav items
   * into this client `Sidebar` without hitting the RSC "functions
   * cannot be passed to Client Components" serialization error. Used
   * when `leading` is not provided.
   */
  icon: IconName;
  /**
   * Pre-rendered leading visual. When present, replaces the default
   * `icon` rendering — used by the company-scoped sidebar to show
   * layout swatches (icon + brand colour chip) next to each layout
   * entry. Must be a serialisable server-rendered ReactNode; pass a
   * JSX element, not a component reference.
   */
  leading?: ReactNode;
  count?: number;
  badge?: string;
};

export type SidebarSection = {
  title?: string;
  items: SidebarItem[];
};

export type SidebarSwitcherEntry = {
  id: string;
  name: string;
  subtitle?: string;
  href: string;
  active?: boolean;
};

export type SidebarWorkspace = {
  name: string;
  /**
   * Small mono line below the workspace/company name. Optional: the
   * portal shell drops it intentionally because the title block
   * already holds everything clients need ("Welcome to Acme"), and an
   * empty line there just looks abandoned.
   */
  subtitle?: string;
  /**
   * Where the header block links: `/admin` for operators, portal home
   * for clients. With no `titleHref`/`titleSwitcher` set — every admin
   * surface — the mark *and* the name are one link to this. Omit to
   * render a static block (e.g. the login page).
   */
  homeHref?: string;
  /**
   * A destination for the title half that differs from `homeHref`,
   * splitting the block back into two controls. Only the portal uses
   * it now, for an operator or single-membership client whose title
   * target isn't their home. Company-scoped admin pages used to point
   * it at `/admin/companies` as the company picker; that moved to the
   * top-bar scope pill.
   */
  titleHref?: string;
  /**
   * Optional glyph shown next to the title block — the chevron is the
   * default and signals "click me for more". Pass `null` to suppress.
   */
  titleGlyph?: ReactNode;
  /**
   * Inline popover used in place of `titleHref` when the title block
   * should act as a tenant picker (multi-membership client portals).
   * Mutually exclusive with `titleHref` — if both are set the switcher
   * wins and the href is ignored. Takes precedence because it's
   * strictly more capable (one click to open, one click to switch)
   * versus a round-trip through `/`.
   */
  titleSwitcher?: {
    /** Accessible heading rendered at the top of the popover. */
    label: string;
    entries: SidebarSwitcherEntry[];
  };
};

export function Sidebar({
  workspace,
  sections,
  activeId,
  showCounts = false,
  variant = 'fixed',
  onNavigate,
  className,
}: {
  workspace: SidebarWorkspace;
  sections: SidebarSection[];
  activeId?: string;
  /**
   * Render each nav item's `count`. Off by default — the totals are
   * ambient density, not something anyone navigates by — and turned on
   * per user under Appearance in their profile.
   *
   * Scoped to `count` alone. `badge` is a warning signal (expiring
   * domains, stale passwords, subnet conflicts) and renders either way:
   * a density preference must not be able to hide an anomaly.
   */
  showCounts?: boolean;
  /**
   * Optional class piped to the outer `<aside>`. Used by `AdminShell`
   * and `CompanyShell` to attach the `.desktop-only` helper so the
   * fixed sidebar hides on phones while the drawer variant takes over.
   */
  className?: string;
  /**
   * `fixed` — the traditional 248 px aside that sits beside the main
   * content. Used on desktop.
   * `drawer` — fills its parent container (the `Sheet` used on mobile
   * viewports) and notifies the caller on nav so the drawer can auto-
   * close after a link is followed. The interior layout is otherwise
   * identical; only the outer width/height/border collapse.
   */
  variant?: 'fixed' | 'drawer';
  /**
   * Invoked when a nav link, search button, or switcher entry is
   * clicked. Lets the drawer host close the sheet after a selection
   * without leaking state ownership into this component.
   */
  onNavigate?: () => void;
}) {
  const isDrawer = variant === 'drawer';
  const pathname = usePathname();

  // Pick the single best matching nav item so "index" routes (e.g.
  // Dashboard at /admin) don't also light up when the user is on a
  // deeper page like /admin/companies. Strategy: a page-mounted
  // `SidebarActive` override wins when it names a real item (e.g. an
  // asset detail forcing its layout's entry, which pathname matching
  // can't know); then the shell-level `activeId` prop; then exact
  // pathname match; then the longest `href` prefix.
  const activeOverride = useSidebarActiveOverride();
  const bestMatchId = (() => {
    const items = sections.flatMap((s) => s.items);
    if (activeOverride && items.some((i) => i.id === activeOverride)) {
      return activeOverride;
    }
    if (activeId) return activeId;
    const all = items.filter((i) => i.href);
    const exact = all.find((i) => i.href === pathname);
    if (exact) return exact.id;
    const prefixed = all
      .filter((i) => pathname.startsWith(`${i.href}/`))
      .sort((a, b) => (b.href?.length ?? 0) - (a.href?.length ?? 0));
    return prefixed[0]?.id;
  })();

  const isActive = (it: SidebarItem) => bestMatchId !== undefined && it.id === bestMatchId;

  return (
    <aside
      className={className}
      style={{
        width: isDrawer ? '100%' : 248,
        flexShrink: 0,
        background: 'var(--surface)',
        borderRight: isDrawer ? 'none' : '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <SidebarHeader workspace={workspace} onNavigate={onNavigate} />

      <div
        className="scroll"
        style={{
          flex: 1,
          overflow: 'auto',
          // Top inset stands in for the search block that used to sit
          // between the header and the nav — search lives in the top
          // bar now. With the rule gone too, this gap is the only thing
          // separating the workspace name from the first nav item, so
          // it runs wider than the 10px the search block had.
          padding: '14px 8px 12px',
          minHeight: 0,
        }}
      >
        {sections.map((section, idx) => (
          <div key={section.title ?? `section-${idx}`}>
            {section.title && <SectionHead>{section.title}</SectionHead>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {section.items.map((item) => (
                <NavItem
                  key={item.id}
                  item={item}
                  active={isActive(item)}
                  showCount={showCounts}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * Header row — the workspace identity block.
 *
 * On admin surfaces this is now a single control: mark + workspace
 * name, linking to `workspace.homeHref`. The title half used to be a
 * second, separate link to `/admin/companies` — the company picker —
 * which is why the two halves were deliberately kept apart. That
 * picker moved into the top-bar scope pill, so with one destination
 * left there is no longer anything for a split to express, and one
 * link over the whole block is the honest shape.
 *
 * The split still exists where a second destination genuinely does:
 *   - `titleSwitcher` — the client portal's tenant picker for users
 *     with more than one membership.
 *   - `titleHref` — a title-only destination distinct from home.
 * In both cases the mark keeps its own link and the title renders as
 * its own control beside it, as before.
 */
function SidebarHeader({
  workspace,
  onNavigate,
}: {
  workspace: SidebarWorkspace;
  onNavigate?: () => void;
}) {
  // Phase 9b.1: sourced from `public/brand/logo-mark.svg` via `AppLogo`.
  // Partners can swap the mark globally by replacing that file — the
  // sidebar, favicon, and OG image all refresh without a code change.
  const logoMark = <AppLogo variant="mark" size={22} />;

  const hasSubtitle = !!workspace.subtitle;
  const titleBlock = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        // Center the single-line name vertically when no subtitle is
        // present so the title row doesn't feel bottom-weighted.
        justifyContent: hasSubtitle ? 'flex-start' : 'center',
      }}
    >
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 550,
          lineHeight: 1.2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {workspace.name}
      </div>
      {hasSubtitle && (
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {workspace.subtitle}
        </div>
      )}
    </div>
  );

  const hasInteractiveTitle = !!workspace.titleSwitcher || !!workspace.titleHref;
  const titleGlyph =
    workspace.titleGlyph === undefined ? (
      hasInteractiveTitle ? (
        <Icon.chevronD size={12} style={{ color: 'var(--dim)' }} />
      ) : null
    ) : (
      workspace.titleGlyph
    );

  const splitTitle = !!workspace.titleSwitcher || !!workspace.titleHref;
  const rowStyle: CSSProperties = {
    padding: '10px 10px 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    position: 'relative',
  };
  // Shell links opt out of Next's viewport/hover prefetch: each
  // prefetch of a dynamic `/admin/**` route triggers a full SSR render
  // (8+ API calls for the company-scoped layout alone), and the sidebar
  // is the omnipresent multiplier that was burning through the per-user
  // throttle budget even for a single operator. First click still feels
  // fast because Next streams RSC mid-navigation; the "instant"
  // prefetch win on dynamic routes is marginal anyway. In-page content
  // links (list rows, row-level actions) keep the default prefetch.
  const markStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: 3,
    borderRadius: 6,
    marginRight: 2,
  };

  // No competing destination: the whole block is one link home.
  if (!splitTitle) {
    const inner = (
      <>
        <span style={markStyle}>{logoMark}</span>
        {titleBlock}
        {titleGlyph}
      </>
    );
    return workspace.homeHref ? (
      <Link
        href={workspace.homeHref}
        title="Go to home"
        onClick={onNavigate}
        prefetch={false}
        style={{ ...rowStyle, color: 'inherit' }}
        className="sidebar-home-block"
      >
        {inner}
      </Link>
    ) : (
      <div style={rowStyle}>{inner}</div>
    );
  }

  return (
    <div style={rowStyle}>
      {workspace.homeHref ? (
        <Link
          href={workspace.homeHref}
          aria-label="Go to home"
          title="Go to home"
          onClick={onNavigate}
          prefetch={false}
          style={markStyle}
          className="sidebar-home"
        >
          {logoMark}
        </Link>
      ) : (
        <div style={markStyle}>{logoMark}</div>
      )}
      {workspace.titleSwitcher ? (
        <TitleSwitcher
          label={workspace.titleSwitcher.label}
          entries={workspace.titleSwitcher.entries}
          currentName={workspace.name}
          onNavigate={onNavigate}
        >
          {titleBlock}
          {titleGlyph}
        </TitleSwitcher>
      ) : workspace.titleHref ? (
        <Link
          href={workspace.titleHref}
          title={`Switch from ${workspace.name}`}
          onClick={onNavigate}
          prefetch={false}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            padding: '4px 6px',
            borderRadius: 5,
            color: 'inherit',
          }}
          className="sidebar-title-link"
        >
          {titleBlock}
          {titleGlyph}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Inline popover used as the sidebar title control when the viewer
 * has multiple tenants to pick from. Keeps everything inside the
 * 248-wide aside — the popover floats a few pixels below the header
 * row and uses `position: absolute` relative to the header, so it
 * stacks above the nav without any portal juggling.
 *
 * Interactions:
 *   - Click the trigger to toggle.
 *   - Click outside (mousedown) or press Escape to close.
 *   - Selecting an entry closes immediately via Next's client-side nav.
 */
function TitleSwitcher({
  label,
  entries,
  currentName,
  children,
  onNavigate,
}: {
  label: string;
  entries: SidebarSwitcherEntry[];
  currentName: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={popoverId}
        title={`Switch from ${currentName}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minWidth: 0,
          padding: '4px 6px',
          borderRadius: 5,
          color: 'inherit',
          background: open ? 'var(--panel-2)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
        className="sidebar-title-link"
      >
        {children}
      </button>
      {open && (
        <div
          id={popoverId}
          role="menu"
          aria-label={label}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-2)',
            padding: 6,
            zIndex: 40,
            maxHeight: 'min(60vh, 420px)',
            overflow: 'auto',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--dim)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              padding: '4px 8px 6px',
            }}
          >
            {label}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {entries.map((entry) => (
              <SwitcherEntry
                key={entry.id}
                entry={entry}
                onSelect={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SwitcherEntry({ entry, onSelect }: { entry: SidebarSwitcherEntry; onSelect: () => void }) {
  const body = (
    <>
      <CompanyMark name={entry.name} size={22} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {entry.name}
        </div>
        {entry.subtitle && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.subtitle}
          </div>
        )}
      </div>
      {entry.active && <Icon.check size={14} style={{ color: 'var(--accent)' }} />}
    </>
  );

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '6px 8px',
    borderRadius: 5,
    textDecoration: 'none',
    color: 'inherit',
    cursor: entry.active ? 'default' : 'pointer',
    background: entry.active ? 'var(--panel-2)' : 'transparent',
  };

  if (entry.active) {
    return (
      <div style={rowStyle} aria-current="true" role="menuitem">
        {body}
      </div>
    );
  }
  return (
    <Link
      href={entry.href}
      role="menuitem"
      onClick={onSelect}
      style={rowStyle}
      className="sidebar-switcher-entry"
      prefetch={false}
    >
      {body}
    </Link>
  );
}

function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--dim)',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        padding: '14px 12px 4px',
      }}
    >
      {children}
    </div>
  );
}

function NavItem({
  item,
  active,
  showCount,
  onNavigate,
}: {
  item: SidebarItem;
  active: boolean;
  showCount: boolean;
  onNavigate?: () => void;
}) {
  const content: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 28,
    padding: '0 10px',
    borderRadius: 5,
    fontWeight: 600,
    fontSize: 13,
    letterSpacing: -0.1,
    color: active ? 'var(--text)' : 'var(--muted)',
    background: active ? 'var(--panel-2)' : 'transparent',
    position: 'relative',
    cursor: 'pointer',
  };
  const inner = (
    <>
      {active && (
        <span
          style={{
            position: 'absolute',
            left: -1,
            top: 6,
            bottom: 6,
            width: 2,
            background: 'var(--accent)',
            borderRadius: 2,
          }}
        />
      )}
      {item.leading ??
        (() => {
          const IconCmp = Icon[item.icon];
          return <IconCmp size={14} stroke={1.5} />;
        })()}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.label}
      </span>
      {showCount && item.count !== undefined && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
          }}
        >
          {item.count.toLocaleString()}
        </span>
      )}
      {item.badge && (
        <span
          style={{
            // Sized so a *two*-digit badge is still a circle, which is
            // the common case for these counts. Mono advance is 0.6em,
            // so at 10px two digits measure 12 and the 4px side padding
            // brings the box to 20 — exactly the height. One digit
            // falls back to `minWidth`, and three or more stretch it
            // into a pill, which is fine.
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 20,
            minWidth: 20,
            padding: '0 4px',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            lineHeight: 1,
            color: 'var(--warn)',
            background: 'var(--warn-soft)',
            borderRadius: 999,
          }}
        >
          {item.badge}
        </span>
      )}
    </>
  );
  if (item.href) {
    return (
      <Link href={item.href} style={content} onClick={onNavigate} prefetch={false}>
        {inner}
      </Link>
    );
  }
  return <div style={content}>{inner}</div>;
}
