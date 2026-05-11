'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../../lib/api';
import {
  companyAccent,
  companyTypeLabel,
  companyTypeTone,
} from '../../lib/company-format';
import type {
  CompanyListItem,
  CompanyParentRef,
} from '../../lib/server-api';
import { CompanyAvatar } from './company-avatar';
import { Icon } from './icon';
import { Input } from './form';
import { Tag } from './tag';

export type CompanyPickerValue = CompanyParentRef;

interface CompanyPickerProps {
  value: CompanyPickerValue | null;
  onChange: (next: CompanyPickerValue | null) => void;
  /**
   * IDs excluded from the dropdown. Typical use is hiding the company
   * the picker is being rendered *inside* (as in parent-company
   * selection) or hiding companies already attached elsewhere.
   */
  excludeCompanyIds?: string[];
  /**
   * Hide archived companies. Default `true` — memberships / parent
   * selection always want live tenants, but leave an escape hatch for
   * surfaces that want to browse the whole history.
   */
  hideArchived?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}

/**
 * Phase 9b.2 — debounced typeahead that hits `/companies?q=` and
 * renders a popover list with avatar, slug, and type chip. Shared
 * between parent-company selection on the settings form and the
 * invite-with-company onboarding flow so both paths behave the same
 * way and the API call is consistent.
 */
export function CompanyPicker({
  value,
  onChange,
  excludeCompanyIds,
  hideArchived = true,
  placeholder = 'Search for a company…',
  autoFocus,
  id,
}: CompanyPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CompanyListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Anchored popover coordinates. We compute them imperatively so the
  // dropdown can portal out of any `overflow: auto` ancestor (e.g. a
  // Dialog body) without being clipped.
  const [popover, setPopover] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const excludeSet = useMemo(
    () => new Set(excludeCompanyIds ?? []),
    [excludeCompanyIds],
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Track the input's screen position while the popover is open so it
  // sticks to the anchor through scroll / resize / dialog reflow.
  useLayoutEffect(() => {
    if (!open || value) {
      setPopover(null);
      return;
    }
    function update() {
      const el = wrapperRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPopover({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      void runSearch(query);
    }, 200);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, hideArchived]);

  async function runSearch(q: string) {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    params.set('limit', '20');
    if (excludeSet.size) {
      params.set('excludeIds', Array.from(excludeSet).join(','));
    }
    const res = await apiFetch<{ items: CompanyListItem[] }>(
      `/companies?${params.toString()}`,
      { signal: ctrl.signal },
    );
    setLoading(false);
    if (!res.ok || !res.data) return;
    let items = res.data.items;
    if (hideArchived) items = items.filter((c) => !c.archivedAt);
    setResults(items);
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      {value ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 8px',
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 5,
          }}
        >
          <CompanyAvatar
            name={value.name}
            color={companyAccent(value.id)}
            size={22}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {value.name}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              /{value.slug}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: 4,
              display: 'inline-flex',
              alignItems: 'center',
            }}
            aria-label="Clear selected company"
          >
            <Icon.x size={12} />
          </button>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--dim)',
              pointerEvents: 'none',
            }}
          >
            <Icon.search size={12} />
          </span>
          <Input
            id={id}
            placeholder={placeholder}
            value={query}
            autoFocus={autoFocus}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            style={{ paddingLeft: 30 }}
          />
        </div>
      )}
      {open && !value && popover && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              top: popover.top,
              left: popover.left,
              width: popover.width,
              zIndex: 1000,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              boxShadow: 'var(--shadow-1)',
              maxHeight: 260,
              overflowY: 'auto',
            }}
          >
            {loading && results.length === 0 ? (
              <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>
                Searching…
              </div>
            ) : results.length === 0 ? (
              <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>
                {query ? 'No matches.' : 'Start typing a company name.'}
              </div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {results.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange({
                          id: c.id,
                          name: c.name,
                          slug: c.slug,
                          archivedAt: c.archivedAt,
                        });
                        setOpen(false);
                        setQuery('');
                      }}
                      style={{
                        display: 'flex',
                        width: '100%',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 10px',
                        background: 'transparent',
                        border: 'none',
                        textAlign: 'left',
                        cursor: 'pointer',
                        color: 'var(--text)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--panel-2)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <CompanyAvatar
                        name={c.name}
                        color={companyAccent(c.id)}
                        size={22}
                        logoUrl={c.logo?.thumbnailUrl ?? null}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>
                          {c.name}
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            color: 'var(--dim)',
                          }}
                        >
                          /{c.slug}
                        </div>
                      </div>
                      <Tag tone={companyTypeTone(c.type)}>
                        {companyTypeLabel(c.type)}
                      </Tag>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
