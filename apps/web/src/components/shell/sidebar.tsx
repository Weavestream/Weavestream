'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AppLogo, CompanyMark, Icon, type IconName, Kbd } from '../ui';
import { useSearchPalette } from '../search/search-palette-provider';

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

export type SidebarUser = {
  initials: string;
  name: string;
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
   * Where the logo/mark links. Always the "leave the current scope"
   * control: `/admin` for operators, portal home for clients. Omit to
   * render the logo as a static chip (e.g. on the login page).
   */
  homeHref?: string;
  /**
   * Where the title+subtitle block links. Used as the "pick a
   * different company" control when the sidebar is company-scoped
   * (points at `/admin/companies`), or omitted when there's no
   * meaningful target (e.g. a client portal user with a single
   * membership).
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
  user,
  activeId,
  onSearch,
  footerAction,
  footerToolbar,
  variant = 'fixed',
  onNavigate,
  className,
}: {
  workspace: SidebarWorkspace;
  sections: SidebarSection[];
  user: SidebarUser;
  activeId?: string;
  /**
   * Optional class piped to the outer `<aside>`. Used by `AdminShell`
   * and `CompanyShell` to attach the `.desktop-only` helper so the
   * fixed sidebar hides on phones while the drawer variant takes over.
   */
  className?: string;
  /**
   * Optional override for the search button click. By default we
   * fall back to the nearest `SearchPaletteProvider`, so every shell
   * that mounts one gets working click-to-open behaviour without
   * having to thread the callback through.
   */
  onSearch?: () => void;
  footerAction?: ReactNode;
  /**
   * Thin icon strip rendered just above the user block, inside the
   * same footer cluster. Used for quick-access glyph links like the
   * "Expiring soon" shortcut — a scope-aware toolbar row that sits
   * outside the main nav sections so it doesn't clutter navigation
   * but is always visible regardless of scroll position.
   */
  footerToolbar?: ReactNode;
  /**
   * `fixed` — the traditional 232 px aside that sits beside the main
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
  // Default the sidebar search button to the palette provider mounted
  // by each shell. Falling back to the hook keeps the button live even
  // when individual shells don't pass `onSearch`, and mirrors the
  // behaviour of the top-bar trigger.
  const palette = useSearchPalette();
  const handleSearchClick = () => {
    (onSearch ?? palette.open)();
    onNavigate?.();
  };

  // Pick the single best matching nav item so "index" routes (e.g.
  // Dashboard at /admin) don't also light up when the user is on a
  // deeper page like /admin/companies. Strategy: exact match wins; if
  // no exact match, the item with the longest `href` prefix wins.
  const bestMatchId = (() => {
    if (activeId) return activeId;
    const all = sections.flatMap((s) => s.items).filter((i) => i.href);
    const exact = all.find((i) => i.href === pathname);
    if (exact) return exact.id;
    const prefixed = all
      .filter((i) => pathname.startsWith(`${i.href}/`))
      .sort((a, b) => (b.href?.length ?? 0) - (a.href?.length ?? 0));
    return prefixed[0]?.id;
  })();

  const isActive = (it: SidebarItem) =>
    bestMatchId !== undefined && it.id === bestMatchId;

  return (
    <aside
      className={className}
      style={{
        width: isDrawer ? '100%' : 232,
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


      <div style={{ padding: 10 }}>
        <button
          type="button"
          onClick={handleSearchClick}
          aria-label="Open search"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            padding: '0 9px',
            background: 'var(--panel-2)',
            borderRadius: 5,
            border: '1px solid var(--line)',
            color: 'var(--dim)',
            width: '100%',
            cursor: 'pointer',
          }}
        >
          <Icon.search size={12} />
          <span style={{ flex: 1, fontSize: 12, textAlign: 'left' }}>
            Search everything
          </span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <div
        className="scroll"
        style={{ flex: 1, overflow: 'auto', padding: '0 8px 12px', minHeight: 0 }}
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
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {footerToolbar && (
        <div
          style={{
            borderTop: '1px solid var(--line)',
            padding: '6px 8px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {footerToolbar}
        </div>
      )}

      <div
        style={{
          borderTop: '1px solid var(--line)',
          padding: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
        }}
      >
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--line-3), var(--panel-2))',
            border: '1px solid var(--line-2)',
            fontSize: 10,
            fontWeight: 600,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--text-2)',
          }}
        >
          {user.initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{user.name}</div>
        </div>
        {footerAction ?? <Icon.dotsV size={14} style={{ color: 'var(--dim)' }} />}
      </div>
    </aside>
  );
}

/**
 * Header row. Structured as two independent controls:
 *
 *  1. The logo/mark is a link to `workspace.homeHref` (when supplied).
 *     This is the "leave the current scope and return to the global
 *     dashboard" affordance.
 *  2. The title+subtitle block is a separate link to
 *     `workspace.titleHref`. On admin pages this points at the company
 *     list (`/admin/companies`), which doubles as the company picker;
 *     on company-scoped pages it's the same target so the switch is
 *     one click away. Clients with a single membership get a plain
 *     static block since there's nowhere meaningful to go.
 *
 * Keeping the two halves as *separate* links (rather than one outer
 * link wrapping both) is intentional: an outer link would steal clicks
 * from the inner one in every browser and make the logo + title act
 * identically, which is the behaviour we explicitly want to avoid.
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

  const hasInteractiveTitle =
    !!workspace.titleSwitcher || !!workspace.titleHref;
  const titleGlyph =
    workspace.titleGlyph === undefined ? (
      hasInteractiveTitle ? (
        <Icon.chevronD size={12} style={{ color: 'var(--dim)' }} />
      ) : null
    ) : (
      workspace.titleGlyph
    );

  return (
    <div
      style={{
        padding: '10px 10px 8px',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        position: 'relative',
      }}
    >
      {workspace.homeHref ? (
        <Link
          href={workspace.homeHref}
          aria-label="Go to home"
          title="Go to home"
          onClick={onNavigate}
          // Shell links opt out of Next's viewport/hover prefetch: each
          // prefetch of a dynamic `/admin/**` route triggers a full SSR
          // render (8+ API calls for the company-scoped layout alone),
          // and the sidebar is the omnipresent multiplier that was
          // burning through the per-user throttle budget even for a
          // single operator. First click still feels fast because Next
          // streams RSC mid-navigation; the "instant" prefetch win on
          // dynamic routes is marginal anyway. In-page content links
          // (list rows, row-level actions) keep the default prefetch.
          prefetch={false}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: 3,
            borderRadius: 6,
            marginRight: 2,
          }}
          className="sidebar-home"
        >
          {logoMark}
        </Link>
      ) : (
        <div style={{ padding: 3, marginRight: 2 }}>{logoMark}</div>
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
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            padding: '4px 6px',
          }}
        >
          {titleBlock}
          {titleGlyph}
        </div>
      )}
    </div>
  );
}

/**
 * Inline popover used as the sidebar title control when the viewer
 * has multiple tenants to pick from. Keeps everything inside the
 * 232-wide aside — the popover floats a few pixels below the header
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
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
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

function SwitcherEntry({
  entry,
  onSelect,
}: {
  entry: SidebarSwitcherEntry;
  onSelect: () => void;
}) {
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
      {entry.active && (
        <Icon.check size={14} style={{ color: 'var(--accent)' }} />
      )}
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
  onNavigate,
}: {
  item: SidebarItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const content: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 28,
    padding: '0 10px',
    borderRadius: 5,
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
      {item.leading ?? (() => {
        const IconCmp = Icon[item.icon];
        return <IconCmp size={14} stroke={1.5} />;
      })()}
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.count !== undefined && (
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
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--warn)',
            background: 'var(--warn-soft)',
            padding: '1px 5px',
            borderRadius: 3,
          }}
        >
          {item.badge}
        </span>
      )}
    </>
  );
  if (item.href) {
    return (
      <Link
        href={item.href}
        style={content}
        onClick={onNavigate}
        prefetch={false}
      >
        {inner}
      </Link>
    );
  }
  return <div style={content}>{inner}</div>;
}
