'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
  type ReactNode,
} from 'react';
import { apiFetch } from '../../lib/api';
import { companyAccent } from '../../lib/company-format';
import type { StarredItem } from '../../lib/server-api';
import { CompanyAvatar, Icon, LayoutSwatch, type IconName } from '../ui';
import { ChatPanelToggle } from '../chat-panel/chat-panel-toggle';

/**
 * Thin icon strip rendered in the sidebar footer, just above the user
 * block. Think "tray" — quick-access, scope-aware shortcuts that
 * don't belong in the main nav but should be a single click away from
 * every page in the shell.
 *
 * Icons are 26×26 tappable targets (meets Apple HIG minimum), spaced
 * so the whole row fits comfortably in the 232px sidebar even with
 * five shortcuts. The active page gets an accent tint to match the
 * main `NavItem` treatment.
 */
export function SidebarToolbar({
  companyId,
  showStarred = true,
  showExpirations = true,
}: {
  /**
   * When present, all scoped shortcuts target the company routes
   * (`/admin/companies/:id/...`). Omit for the global admin variant
   * where the same shortcuts resolve to cross-tenant routes.
   */
  companyId?: string;
  /** Hide the admin-route starred drawer on client-only portal shells. */
  showStarred?: boolean;
  /**
   * Hide the "Expiring soon" shortcut on client portal shells. The
   * destination lives under `/admin` and would just bounce a
   * CLIENT_USER home, so we omit it entirely instead of teasing a
   * dead link.
   */
  showExpirations?: boolean;
}) {
  const base = companyId ? `/admin/companies/${companyId}` : '/admin';

  return (
    <>
      {showExpirations && (
        <ToolbarIconLink
          href={`${base}/expirations`}
          icon="clock"
          label="Expiring soon"
        />
      )}
      {showStarred && <StarredQuickAccessTrigger />}
      <ChatPanelToggle />
    </>
  );
}

function StarredQuickAccessTrigger() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<StarredItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const gap = 8;
    const viewportPad = 12;
    const width = Math.min(340, window.innerWidth - viewportPad * 2);
    const opensRight = rect.right + gap + width <= window.innerWidth - viewportPad;
    const left = opensRight
      ? rect.right + gap
      : Math.max(viewportPad, rect.left - gap - width);

    setPosition({
      left,
      // Align the popover's lower edge with the footer icon row so it
      // opens upward from the tray instead of taking over the viewport.
      bottom: Math.max(viewportPad, window.innerHeight - rect.bottom),
      width,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiFetch<{ items: StarredItem[] }>('/me/stars', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          setError('Could not load starred items.');
          setItems([]);
          return;
        }
        setItems(res.data?.items ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('Could not load starred items.');
          setItems([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, updatePosition]);

  return (
    <>
      <ToolbarIconButton
        buttonRef={buttonRef}
        icon="star"
        label="Open starred items"
        active={open}
        onClick={() => {
          updatePosition();
          setOpen((v) => !v);
        }}
      />
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Starred items"
          style={{
            position: 'fixed',
            left: position?.left ?? 12,
            bottom: position?.bottom ?? 64,
            width: position?.width ?? 340,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'min(460px, calc(100vh - 24px))',
            zIndex: 70,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-2)',
            overflow: 'hidden',
          }}
        >
          <StarredQuickPanel
            items={items}
            loading={loading}
            error={error}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}

function StarredQuickPanel({
  items,
  loading,
  error,
  onClose,
}: {
  items: StarredItem[] | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <>
      <div
        style={{
          padding: '12px 12px 10px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Starred</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close starred items"
          title="Close"
          className="sidebar-toolbar-icon"
          style={{
            width: 28,
            height: 28,
            border: 'none',
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--muted)',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <Icon.x size={14} />
        </button>
      </div>

      <div
        className="scroll"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}
      >
        {loading && !items ? (
          <DrawerState>Loading starred items…</DrawerState>
        ) : error ? (
          <DrawerState tone="danger">{error}</DrawerState>
        ) : !items || items.length === 0 ? (
          <DrawerState>
            Star a company, password, asset, or article from its detail page to
            pin it here.
          </DrawerState>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((item) => (
              <StarredQuickAccessItem
                key={`${item.type}:${item.id}`}
                item={item}
                onNavigate={onClose}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function StarredQuickAccessItem({
  item,
  onNavigate,
}: {
  item: StarredItem;
  onNavigate: () => void;
}) {
  const archived =
    item.archivedAt !== null ||
    (item.type !== 'company' && item.companyArchivedAt !== null);

  return (
    <Link
      href={starredHref(item)}
      onClick={onNavigate}
      prefetch={false}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 10px',
        borderRadius: 8,
        border: '1px solid var(--line)',
        background: 'var(--surface)',
        color: 'var(--text)',
        textDecoration: 'none',
      }}
      className="sidebar-switcher-entry"
    >
      <StarredGlyph item={item} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 550,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.name}
        </div>
        <div
          style={{
            marginTop: 2,
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {starredSubline(item)}
          {archived ? ' · archived' : ''}
        </div>
      </div>
      <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
    </Link>
  );
}

function StarredGlyph({ item }: { item: StarredItem }) {
  switch (item.type) {
    case 'company':
      return (
        <CompanyAvatar
          name={item.name}
          color={companyAccent(item.id)}
          size={28}
          logoUrl={item.logo?.thumbnailUrl ?? item.logo?.url ?? null}
        />
      );
    case 'asset':
      return (
        <LayoutSwatch
          icon={item.layoutIcon ?? 'box'}
          color="var(--info)"
          size={28}
        />
      );
    case 'password':
      return <TypeChip icon={<Icon.key size={14} />} color="var(--warn)" />;
    case 'article':
      return <TypeChip icon={<Icon.doc size={14} />} color="var(--accent)" />;
  }
}

function TypeChip({ icon, color }: { icon: ReactNode; color: string }) {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 5,
        display: 'grid',
        placeItems: 'center',
        background: `color-mix(in oklch, ${color} 14%, transparent)`,
        color,
        border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
        flexShrink: 0,
      }}
    >
      {icon}
    </div>
  );
}

function starredHref(item: StarredItem): string {
  switch (item.type) {
    case 'company':
      return `/admin/companies/${item.id}`;
    case 'password':
      return `/admin/companies/${item.companyId}/passwords/${item.id}`;
    case 'asset':
      return `/admin/companies/${item.companyId}/assets/${item.id}`;
    case 'article':
      return `/admin/companies/${item.companyId}/articles/${item.id}`;
  }
}

function starredSubline(item: StarredItem): string {
  switch (item.type) {
    case 'company':
      return `${item.memberCount} member${item.memberCount === 1 ? '' : 's'}`;
    case 'asset':
      return item.layoutName
        ? `${item.layoutName} · ${item.companyName}`
        : item.companyName;
    case 'password':
      return `Password · ${item.companyName}`;
    case 'article':
      return `Article · ${item.companyName}`;
  }
}

function DrawerState({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'danger';
}) {
  return (
    <div
      style={{
        padding: 14,
        border: '1px dashed var(--line)',
        borderRadius: 8,
        color: tone === 'danger' ? 'var(--danger)' : 'var(--muted)',
        background: 'var(--surface)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function ToolbarIconLink({
  href,
  icon,
  label,
  badge,
}: {
  href: string;
  icon: IconName;
  label: string;
  /** Optional red dot for "has items" affordance — rendered when `> 0`. */
  badge?: number;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const IconCmp = Icon[icon];

  const style: CSSProperties = {
    width: 26,
    height: 26,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 5,
    color: active ? 'var(--text)' : 'var(--muted)',
    background: active ? 'var(--panel-2)' : 'transparent',
    position: 'relative',
    cursor: 'pointer',
  };

  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="sidebar-toolbar-icon"
      style={style}
      prefetch={false}
    >
      <IconCmp size={14} stroke={1.5} />
      {badge !== undefined && badge > 0 && <BadgeDot />}
    </Link>
  );
}

function ToolbarIconButton({
  buttonRef,
  icon,
  label,
  active = false,
  onClick,
}: {
  buttonRef?: Ref<HTMLButtonElement>;
  icon: IconName;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  const IconCmp = Icon[icon];

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="sidebar-toolbar-icon"
      style={{
        width: 26,
        height: 26,
        border: 'none',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 5,
        color: active ? 'var(--text)' : 'var(--muted)',
        background: active ? 'var(--panel-2)' : 'transparent',
        position: 'relative',
        cursor: 'pointer',
      }}
    >
      <IconCmp size={14} stroke={1.5} />
    </button>
  );
}

function BadgeDot(): ReactNode {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--warn)',
        boxShadow: '0 0 0 1.5px var(--surface)',
      }}
    />
  );
}
