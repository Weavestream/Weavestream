'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../lib/api';
import { Icon } from './icon';
import { useToast } from './toast';

/**
 * Phase 9b.3 — per-user star toggle for companies, passwords, assets, and articles.
 *
 * Optimistic: flips local state immediately, reverts on API failure.
 * Exposed as a compact icon-only button so it can sit inline in a
 * table row without stealing room. `size="md"` + `label="Star"` are
 * used in the detail header to match the rest of the action bar.
 */

export type EntityType = 'company' | 'password' | 'asset' | 'article';

interface StarButtonProps {
  entityType: EntityType;
  entityId: string;
  initialStarred: boolean;
  /**
   * Show a text label next to the icon. Defaults off (icon-only) for
   * list rows; the header action passes `true` for discoverability.
   */
  showLabel?: boolean;
  /**
   * Size in px for the icon. Rows use a slightly smaller glyph than
   * the header action.
   */
  iconSize?: number;
  /**
   * Optional callback invoked after a successful toggle with the new
   * state. Used by the operator home Starred panel to drop a row
   * without a full reload.
   */
  onToggled?: (starred: boolean) => void;
  className?: string;
}

const ENTITY_TYPE_TO_PATH: Record<EntityType, string> = {
  company: 'companies',
  password: 'passwords',
  asset: 'assets',
  article: 'articles',
};

const ENTITY_TYPE_TO_LABEL: Record<EntityType, string> = {
  company: 'company',
  password: 'password',
  asset: 'asset',
  article: 'article',
};

export function StarButton({
  entityType,
  entityId,
  initialStarred,
  showLabel = false,
  iconSize = 14,
  onToggled,
  className,
}: StarButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const [starred, setStarred] = useState(initialStarred);
  const [pending, setPending] = useState(false);

  async function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    // Crucial when the button sits inside a clickable table row — we
    // don't want starring to navigate away from the list.
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    const next = !starred;
    setStarred(next);
    setPending(true);
    const pathSegment = ENTITY_TYPE_TO_PATH[entityType];
    const res = await apiFetch(`/me/stars/${pathSegment}/${entityId}`, {
      method: next ? 'PUT' : 'DELETE',
    });
    setPending(false);
    if (!res.ok) {
      setStarred(!next);
      const problem = res.problem as { detail?: string } | undefined;
      toast.push(
        problem?.detail ??
          (next ? 'Could not star.' : 'Could not unstar.'),
        'danger',
      );
      return;
    }
    onToggled?.(next);
    // Keep server components (e.g. operator home's starred list) in
    // sync — cheap because detail endpoints and /me/stars are the only
    // endpoints that care.
    router.refresh();
  }

  const entityLabel = ENTITY_TYPE_TO_LABEL[entityType];
  const ariaLabel = starred ? `Unstar ${entityLabel}` : `Star ${entityLabel}`;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={starred}
      aria-label={ariaLabel}
      title={starred ? 'Unstar' : 'Star'}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        // `showLabel` puts this button in the detail-header action row;
        // height + padding match `Btn` `md` so heights line up.
        height: showLabel ? 30 : 24,
        padding: showLabel ? '0 11px' : 0,
        width: showLabel ? undefined : 24,
        justifyContent: 'center',
        background: showLabel
          ? starred
            ? 'color-mix(in oklch, var(--accent) 14%, transparent)'
            : 'var(--panel-2)'
          : 'transparent',
        border: showLabel ? '1px solid var(--line-2)' : 'none',
        borderRadius: 5,
        cursor: pending ? 'progress' : 'pointer',
        color: starred ? 'var(--accent)' : 'var(--muted)',
        fontSize: 12.5,
        fontWeight: 500,
        transition: 'color 120ms ease, background 120ms ease',
      }}
      onMouseEnter={(e) => {
        if (!starred) e.currentTarget.style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        if (!starred) e.currentTarget.style.color = 'var(--muted)';
      }}
    >
      <StarGlyph filled={starred} size={iconSize} />
      {showLabel && <span>{starred ? 'Starred' : 'Star'}</span>}
    </button>
  );
}

/**
 * Inline SVG rather than `Icon.star` so we can vary `fill` between
 * the two states cheaply. The d is copied from `Icon.star` so the
 * outline matches the rest of the iconography.
 */
function StarGlyph({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path d="M8 1.5l2 4.5 5 .5-3.5 3.5 1 5-4.5-2.5-4.5 2.5 1-5L1 6.5l5-.5 2-4.5z" />
    </svg>
  );
}
