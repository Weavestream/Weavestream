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
import type { ArticlePage, AssetPage } from '../../lib/server-api';
import { Icon } from '../ui';

/**
 * Popover that lets the user pick an article or asset to attach as
 * @-mention context. Anchored to the composer textarea; positions
 * itself just above the textarea so it doesn't get clipped by the
 * chat panel's narrow width.
 *
 * Search is debounced (180 ms) and scoped to the active company.
 * Articles and assets are fetched in parallel (`limit=5` each), so
 * the merged popover stays under ~10 items.
 */
export type MentionCandidate = {
  kind: 'article' | 'asset';
  id: string;
  title: string;
  /** Dim sub-label shown to the right of the title (e.g. layout name). */
  subtitle?: string;
};

type Row =
  | { type: 'header'; label: string; key: string }
  | { type: 'item'; candidate: MentionCandidate; key: string };

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
  onSelect: (item: MentionCandidate) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [articles, setArticles] = useState<MentionCandidate[]>([]);
  const [assets, setAssets] = useState<MentionCandidate[]>([]);
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

  // Debounced parallel search across articles + assets. We use
  // `Promise.allSettled` so a transient failure in one endpoint
  // doesn't blank out the other — e.g. a CLIENT_USER who lacks
  // `asset.read` permission still sees article matches.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams({ limit: '5' });
      if (query) params.set('q', query);
      const qs = params.toString();
      const [articleRes, assetRes] = await Promise.allSettled([
        apiFetch<ArticlePage>(`/companies/${companyId}/articles?${qs}`),
        apiFetch<AssetPage>(`/companies/${companyId}/assets?${qs}`),
      ]);
      if (cancelled) return;
      setLoading(false);
      const nextArticles: MentionCandidate[] =
        articleRes.status === 'fulfilled' && articleRes.value.data
          ? articleRes.value.data.items
              .filter((a) => !excludeIds.has(a.id))
              .map((a) => ({
                kind: 'article' as const,
                id: a.id,
                title: a.title,
              }))
          : [];
      const nextAssets: MentionCandidate[] =
        assetRes.status === 'fulfilled' && assetRes.value.data
          ? assetRes.value.data.items
              .filter((a) => !excludeIds.has(a.id))
              .map((a) => ({
                kind: 'asset' as const,
                id: a.id,
                title: a.name,
                subtitle: a.layoutName,
              }))
          : [];
      setArticles(nextArticles);
      setAssets(nextAssets);
      setHighlight(0);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [companyId, query, excludeIds]);

  // Flatten the two groups into a single navigable list. Headers are
  // rendered but skipped by keyboard nav. A group's header is
  // suppressed when its block is empty so a single-result search
  // doesn't show an orphan label.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (articles.length > 0) {
      out.push({ type: 'header', label: 'Articles', key: 'h-articles' });
      for (const a of articles) {
        out.push({ type: 'item', candidate: a, key: `a-${a.id}` });
      }
    }
    if (assets.length > 0) {
      out.push({ type: 'header', label: 'Assets', key: 'h-assets' });
      for (const a of assets) {
        out.push({ type: 'item', candidate: a, key: `s-${a.id}` });
      }
    }
    return out;
  }, [articles, assets]);

  // Indexes of selectable rows (items only) — drives keyboard nav.
  const itemIndexes = useMemo(
    () => rows.flatMap((r, i) => (r.type === 'item' ? [i] : [])),
    [rows],
  );

  // Clamp the highlight whenever the list shrinks so the active row
  // never escapes the rendered set.
  useEffect(() => {
    if (highlight >= itemIndexes.length) {
      setHighlight(Math.max(0, itemIndexes.length - 1));
    }
  }, [itemIndexes.length, highlight]);

  // Keyboard nav: a global keydown listener while the picker is open
  // lets the composer textarea keep focus while Arrow/Enter/Escape
  // drive the picker. We capture so the composer's own handler never
  // sees these keys. `highlight` is an index into `itemIndexes` (i.e.
  // ignores header rows entirely).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) =>
          Math.min(Math.max(itemIndexes.length - 1, 0), h + 1),
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const rowIdx = itemIndexes[highlight];
        const row = rowIdx !== undefined ? rows[rowIdx] : undefined;
        if (row && row.type === 'item') {
          e.preventDefault();
          e.stopPropagation();
          onSelect(row.candidate);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rows, itemIndexes, highlight, onSelect, onClose]);

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
    maxHeight: 320,
    overflow: 'auto',
  };

  const isEmpty = rows.length === 0;

  return (
    <div ref={popRef} role="listbox" aria-label="Mention suggestions" style={wrap}>
      {loading && isEmpty && <Empty label="Searching…" />}
      {!loading && isEmpty && (
        <Empty label={query ? 'No matches' : 'Type to search articles & assets'} />
      )}
      {rows.map((row, i) => {
        if (row.type === 'header') {
          return <GroupHeader key={row.key} label={row.label} />;
        }
        const selectableIdx = itemIndexes.indexOf(i);
        const isActive = selectableIdx === highlight;
        return (
          <Candidate
            key={row.key}
            item={row.candidate}
            active={isActive}
            onMouseEnter={() => setHighlight(Math.max(0, selectableIdx))}
            onClick={() => onSelect(row.candidate)}
          />
        );
      })}
    </div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '6px 8px 2px',
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: 'var(--dim)',
      }}
    >
      {label}
    </div>
  );
}

function Candidate({
  item,
  active,
  onMouseEnter,
  onClick,
}: {
  item: MentionCandidate;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const IconCmp = item.kind === 'asset' ? Icon.box : Icon.doc;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        background: active ? 'var(--panel-2)' : 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        color: 'var(--text)',
        fontSize: 12.5,
        textAlign: 'left',
      }}
    >
      <IconCmp size={12} style={{ color: 'var(--dim)', flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={item.title}
      >
        {item.title}
      </span>
      {item.subtitle ? (
        <span
          style={{
            color: 'var(--dim)',
            fontSize: 11,
            flexShrink: 0,
            maxWidth: '40%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={item.subtitle}
        >
          {item.subtitle}
        </span>
      ) : null}
    </button>
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
