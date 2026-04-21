'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../../../lib/api';
import {
  CompanyAvatar,
  Icon,
  Input,
  Tag,
} from '../../../../../components/ui';
import {
  companyAccent,
  companyTypeLabel,
  companyTypeTone,
} from '../../../../../lib/company-format';
import type {
  CompanyListItem,
  CompanyParentRef,
} from '../../../../../lib/server-api';

interface ParentCompanyPickerProps {
  currentCompanyId: string;
  value: CompanyParentRef | null;
  onChange: (next: CompanyParentRef | null) => void;
}

/**
 * Typeahead picker for the `parentCompanyId` field. Server filters
 * out `currentCompanyId`, but cycle detection lives on the API — the
 * client just forbids obvious self-selection up front. Non-super
 * admins only see the companies they're a member of, mirroring the
 * list view.
 */
export function ParentCompanyPicker({
  currentCompanyId,
  value,
  onChange,
}: ParentCompanyPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CompanyListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Debounce to cut down on chatty requests while the operator types.
    const handle = window.setTimeout(() => {
      void runSearch(query);
    }, 180);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  async function runSearch(q: string) {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    params.set('limit', '20');
    params.set('excludeIds', currentCompanyId);
    const res = await apiFetch<{ items: CompanyListItem[] }>(
      `/companies?${params.toString()}`,
      { signal: ctrl.signal },
    );
    setLoading(false);
    if (!res.ok || !res.data) return;
    setResults(res.data.items.filter((c) => !c.archivedAt));
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
            <div style={{ fontSize: 13, fontWeight: 500 }}>{value.name}</div>
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
            aria-label="Clear parent company"
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
            }}
          >
            <Icon.search size={12} />
          </span>
          <Input
            placeholder="Search for a parent company…"
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            style={{ paddingLeft: 30 }}
          />
        </div>
      )}
      {open && !value && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 10,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-1)',
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {loading && results.length === 0 ? (
            <div
              style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}
            >
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div
              style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}
            >
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
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div>
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
        </div>
      )}
    </div>
  );
}
