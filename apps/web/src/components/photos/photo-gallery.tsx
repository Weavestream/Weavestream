import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '../ui';
import { buildPhotosHref } from '../../lib/photo-query';

/** Responsive square-tile grid for `PhotoTile`s. */
export function PhotoGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 10,
        padding: 14,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Empty gallery body. The copy differs per surface (admin speaks to
 * operators, portal to clients), so it is passed in.
 */
export function PhotoEmptyState({
  message,
  hint,
  showIcon = false,
}: {
  message: string;
  hint?: string;
  showIcon?: boolean;
}) {
  return (
    <div
      style={{
        padding: 48,
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      {showIcon && (
        <div style={{ fontSize: 24, marginBottom: 8 }}>
          <Icon.doc size={24} />
        </div>
      )}
      <div>{message}</div>
      {hint && (
        <div
          style={{
            marginTop: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--dim)',
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Cursor pagination footer: one "Load more" link that keeps the active
 * filters. Renders nothing on the last page. `includeNonLatest` is
 * admin-only; the portal never passes it.
 */
export function PhotoLoadMore({
  basePath,
  nextCursor,
  attachedToType,
  attachedToId,
  includeNonLatest,
}: {
  basePath: string;
  nextCursor: string | null;
  attachedToType?: string;
  attachedToId?: string;
  includeNonLatest?: boolean;
}) {
  if (!nextCursor) return null;
  const href = buildPhotosHref(basePath, {
    attachedToType,
    attachedToId,
    includeNonLatest,
    cursor: nextCursor,
  });
  return (
    <div
      style={{
        padding: '10px 14px',
        borderTop: '1px solid var(--line)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <Link
        href={href}
        style={{
          fontSize: 11.5,
          fontFamily: 'var(--font-mono)',
          color: 'var(--accent)',
        }}
      >
        Load more →
      </Link>
    </div>
  );
}
