'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui';

/**
 * Compact "Filter by tag" dropdown shared by every asset list surface
 * (per-layout `LayoutAssetsTable` and the per-company `AssetsTable`).
 * It is purely presentational — the parent owns the selected tag id and
 * the list of available tags. Closes on outside click + Escape.
 */
export function TagFilterMenu({
  tags,
  value,
  activeName,
  onChange,
}: {
  /** Distinct `{id, name}` chips currently filterable. */
  tags: Array<{ id: string; name: string }>;
  /** Selected tag id, or `null` when no filter is active. */
  value: string | null;
  /** Display name of the active tag (kept separate so the chip survives even if `tags` recomputes mid-render). */
  activeName: string | null;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, filter]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: '0 10px',
          background: value ? 'var(--accent-soft)' : 'transparent',
          border: '1px solid',
          borderColor: value ? 'var(--accent)' : 'var(--line-2)',
          borderRadius: 5,
          fontSize: 12,
          color: value ? 'var(--accent)' : 'var(--text-2)',
          cursor: 'pointer',
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Icon.tag size={12} />
        {value && activeName ? activeName : 'Filter by tag'}
        {value ? (
          <span
            role="button"
            aria-label="Clear tag filter"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              marginLeft: 2,
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            <Icon.x size={11} />
          </span>
        ) : (
          <Icon.chevronD size={11} />
        )}
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 220,
            maxWidth: 320,
            background: 'var(--panel)',
            border: '1px solid var(--line-2)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 320,
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--line)' }}>
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search tags…"
              style={{
                width: '100%',
                background: 'var(--panel-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 4,
                padding: '6px 8px',
                fontSize: 12.5,
                color: 'var(--text)',
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              }}
            />
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 ? (
              <div
                style={{
                  padding: '14px 12px',
                  fontSize: 12,
                  color: 'var(--muted)',
                  textAlign: 'center',
                }}
              >
                No tags match.
              </div>
            ) : (
              filtered.map((t) => {
                const active = t.id === value;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(active ? null : t.id);
                      setOpen(false);
                      setFilter('');
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '7px 10px',
                      background: active ? 'var(--accent-soft)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text)',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12.5,
                      textAlign: 'left',
                    }}
                  >
                    <Icon.tag size={11} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t.name}
                    </span>
                    {active && <Icon.check size={11} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
