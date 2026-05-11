'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { apiFetch } from '../../lib/api';
import type { ArticlePage } from '../../lib/server-api';
import { Icon } from '../ui';

/**
 * Popover that lets the user pick an article to attach as @-mention
 * context. Anchored to the composer textarea; positions itself just
 * above the textarea so it doesn't get clipped by the chat panel's
 * narrow width.
 *
 * Search is debounced (180 ms) and scoped to the active company. We
 * intentionally don't preload the list — articles can be hundreds per
 * company and the user is typing toward a specific one.
 */
export type MentionCandidate = {
  id: string;
  title: string;
};

export function MentionPicker({
  anchorRef,
  companyId,
  query,
  excludeIds,
  onSelect,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  companyId: string;
  query: string;
  excludeIds: ReadonlySet<string>;
  onSelect: (article: MentionCandidate) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(
    null,
  );

  useEffect(() => {
    function place() {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({
        left: Math.max(8, r.left),
        top: Math.max(8, r.top - 8),
        width: Math.max(180, r.width),
      });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current && anchorRef.current.contains(t)) return;
      onClose();
    }
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [anchorRef, onClose]);

  // Debounced search.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams({ limit: '8' });
      if (query) params.set('q', query);
      const res = await apiFetch<ArticlePage>(
        `/companies/${companyId}/articles?${params.toString()}`,
      );
      if (cancelled) return;
      setLoading(false);
      const all = res.data?.items ?? [];
      const filtered = all
        .filter((a) => !excludeIds.has(a.id))
        .map((a) => ({ id: a.id, title: a.title }));
      setItems(filtered);
      setHighlight(0);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [companyId, query, excludeIds]);

  const visible = useMemo(() => items.slice(0, 8), [items]);

  // Keyboard nav: a global keydown listener while the picker is open
  // lets the composer textarea keep focus while Arrow/Enter/Escape
  // drive the picker. We capture so the composer's own handler never
  // sees these keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => Math.min(Math.max(visible.length - 1, 0), h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = visible[highlight];
        if (pick) {
          e.preventDefault();
          e.stopPropagation();
          onSelect(pick);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, highlight, onSelect, onClose]);

  if (!pos) return null;

  const wrap: CSSProperties = {
    position: 'fixed',
    left: pos.left,
    top: pos.top,
    width: pos.width,
    transform: 'translateY(-100%)',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
    padding: 4,
    zIndex: 90,
    maxHeight: 260,
    overflow: 'auto',
  };

  return (
    <div ref={popRef} role="listbox" aria-label="Article suggestions" style={wrap}>
      {loading && visible.length === 0 && <Empty label="Searching…" />}
      {!loading && visible.length === 0 && (
        <Empty label={query ? 'No matches' : 'Type to search articles'} />
      )}
      {visible.map((a, i) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={i === highlight}
          onMouseEnter={() => setHighlight(i)}
          onClick={() => onSelect(a)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            background: i === highlight ? 'var(--panel-2)' : 'transparent',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            color: 'var(--text)',
            fontSize: 12.5,
            textAlign: 'left',
          }}
        >
          <Icon.doc size={12} style={{ color: 'var(--dim)', flexShrink: 0 }} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={a.title}
          >
            {a.title}
          </span>
        </button>
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '10px 8px',
        color: 'var(--dim)',
        fontSize: 12,
        textAlign: 'center',
      }}
    >
      {label}
    </div>
  );
}
