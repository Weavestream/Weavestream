'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { UserRole } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { initialsFromName, roleLabel } from '../../lib/roles';
import type { UserListItem, UserPage } from '../../lib/server-api';
import { Icon } from './icon';
import { Input } from './form';
import { Tag } from './tag';

export type UserPickerValue = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
};

interface UserPickerProps {
  value: UserPickerValue | null;
  onChange: (next: UserPickerValue | null) => void;
  /**
   * Restrict server results by global `UserRole`. Useful when the caller
   * only wants to show client users for a client-facing membership flow.
   */
  roleFilter?: UserRole[];
  /**
   * IDs that must never appear in the dropdown (e.g. users already on the
   * company). Applied after the server response so the role filter still
   * gets its full debounced hit — keeps the list length stable when an
   * operator types past a match that's already been taken.
   */
  excludeUserIds?: string[];
  /**
   * Only include active (non-deactivated) users. Default `true` — the
   * membership flows never want to add someone who can't log in.
   */
  activeOnly?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}

/**
 * Phase 9b.2 — scalable replacement for the bounded `<Select>` that
 * backed the old "Add member" dialog. Debounces against `/users?q=` so
 * this works for tenants with tens of thousands of users; server does
 * the case-insensitive name/email contains match, we only layer on
 * client-side role + exclude filtering so the dropdown list length
 * stays predictable.
 *
 * API surface mirrors `ParentCompanyPicker` — single value, chip on
 * selection with an X to clear, popover list with avatar/initial and
 * role chip below the name.
 */
export function UserPicker({
  value,
  onChange,
  roleFilter,
  excludeUserIds,
  activeOnly = true,
  placeholder = 'Search users by name or email…',
  autoFocus,
  id,
}: UserPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const excludeSet = useMemo(
    () => new Set(excludeUserIds ?? []),
    [excludeUserIds],
  );

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
    const handle = window.setTimeout(() => {
      void runSearch(query);
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, activeOnly, JSON.stringify(roleFilter ?? [])]);

  async function runSearch(q: string) {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    params.set('limit', '15');
    if (activeOnly) params.set('isActive', 'true');
    // Server supports a single `role=` filter; when the caller wants more
    // than one role we over-fetch on the first role and rely on the
    // client-side narrowing below. Membership flows almost always pass at
    // most one role so this isn't a real cost in practice.
    if (roleFilter && roleFilter.length === 1 && roleFilter[0]) {
      params.set('role', roleFilter[0]);
    }
    const res = await apiFetch<UserPage>(
      `/users?${params.toString()}`,
      { signal: ctrl.signal },
    );
    setLoading(false);
    if (!res.ok || !res.data) return;
    let items = res.data.items;
    if (roleFilter && roleFilter.length > 1) {
      items = items.filter((u) => roleFilter.includes(u.role));
    }
    if (excludeSet.size) {
      items = items.filter((u) => !excludeSet.has(u.id));
    }
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
          <UserAvatar name={value.name} />
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
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {value.email}
            </div>
          </div>
          <Tag tone="outline">{roleLabel(value.role)}</Tag>
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
            aria-label="Clear selected user"
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
            <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>
              {query ? 'No matches.' : 'Start typing a name or email.'}
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange({
                        id: u.id,
                        email: u.email,
                        name: u.name,
                        role: u.role,
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
                    <UserAvatar name={u.name} />
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
                        {u.name}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--dim)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {u.email}
                      </div>
                    </div>
                    <Tag tone="outline">{roleLabel(u.role)}</Tag>
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

function UserAvatar({ name }: { name: string }) {
  return (
    <div
      aria-hidden
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        borderRadius: 4,
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-line)',
        color: 'var(--accent)',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.5,
      }}
    >
      {initialsFromName(name)}
    </div>
  );
}
