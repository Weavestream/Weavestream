'use client';

/**
 * Phase 6 global & scoped search palette. Powered by `cmdk`, which
 * gives us the Hudu-style keyboard-first interaction — ↑/↓ to move,
 * Enter to open, Esc to dismiss — for free. Server ranks results,
 * so `shouldFilter={false}` turns off cmdk's own substring filter.
 *
 * Scope model: if `scopedCompany` is set (we're inside a company
 * sidebar) the palette starts company-scoped; Alt+G toggles to
 * global. Without a scope, the "Global" toggle is disabled.
 *
 * Per-user defaults (loaded from `Me.searchDefaults`) seed the
 * Comprehensive + Global toggles on first open. Per-palette state
 * sticks until the palette is closed.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import type { SearchHit, SearchResponse, UserSearchDefaults } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { Icon, Kbd } from '../ui';

export interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  scopedCompany: { id: string; name: string } | null;
  defaults: UserSearchDefaults | null;
}

// We debounce user input by this many ms before hitting /search.
// Matches Hudu's perceived latency — snappy but not hammering the
// DB on every keystroke.
const DEBOUNCE_MS = 180;

export function SearchPalette({
  open,
  onClose,
  scopedCompany,
  defaults,
}: SearchPaletteProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Controlled cmdk selection. We seed it to the first hit's value
  // whenever results arrive so the user can press ↓ and immediately
  // land on the 2nd item (instead of waiting for the 1st arrow press
  // to merely "establish" a highlight). Also keeps the highlight in
  // sync across async result swaps, which cmdk does not guarantee
  // when `shouldFilter` is off.
  const [selected, setSelected] = useState<string>('');

  // Defaults seed once per open; user edits the toggles inside the
  // palette and the state is reset on close.
  const defaultGlobal = defaults?.defaultGlobal ?? false;
  const defaultComprehensive = defaults?.defaultComprehensive ?? false;
  const [comprehensive, setComprehensive] = useState(defaultComprehensive);
  const [includeArchived, setIncludeArchived] = useState(false);
  // If we have a scoped company, "global" means: don't pass companyId.
  // The initial value respects `defaultGlobal` — true means start
  // globally even when viewing a company.
  const [global, setGlobal] = useState(!scopedCompany || defaultGlobal);

  // Reset state every time the palette reopens so defaults
  // re-apply cleanly. Query stays empty; toggles re-seed.
  useEffect(() => {
    if (open) {
      setQuery('');
      setItems([]);
      setError(null);
      setSelected('');
      setComprehensive(defaultComprehensive);
      setIncludeArchived(false);
      setGlobal(!scopedCompany || defaultGlobal);
      // Focus on mount — cmdk mounts behind a portal, so we
      // explicitly pull focus instead of relying on autoFocus.
      // Also clear any value the browser/OS may have already
      // autofilled (e.g. macOS "from Messages" SMS codes) before the
      // user sees the palette.
      queueMicrotask(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        if (input.value) {
          input.value = '';
          setQuery('');
        }
      });
    }
  }, [open, defaultComprehensive, defaultGlobal, scopedCompany]);

  // Whenever a new batch of results arrives, pin the selection to the
  // first item so ↑/↓ feel responsive on the very first press. If
  // items disappear, clear the selection so stale highlights don't
  // linger across queries.
  useEffect(() => {
    if (items.length === 0) {
      setSelected('');
      return;
    }
    const first = `${items[0].kind}:${items[0].id}`;
    setSelected((current) => {
      if (current && items.some((h) => `${h.kind}:${h.id}` === current)) {
        return current;
      }
      return first;
    });
  }, [items]);

  // Alt+G — Hudu's scope toggle. Only meaningful when we have a
  // company scope; otherwise the button is already disabled and the
  // shortcut is a no-op.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.altKey && (e.key === 'g' || e.key === 'G')) {
        if (scopedCompany) {
          e.preventDefault();
          setGlobal((v) => !v);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, scopedCompany]);

  // Debounced server fetch. Cancels the in-flight request on every
  // new keystroke so latency never backs up.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();

    const q = query.trim();
    if (q.length === 0) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({ q });
      if (scopedCompany && !global) params.set('companyId', scopedCompany.id);
      if (comprehensive) params.set('comprehensive', 'true');
      if (includeArchived) params.set('includeArchived', 'true');
      params.set('limit', '20');

      const res = await apiFetch<SearchResponse>(
        `/search?${params.toString()}`,
        { signal: controller.signal },
      );
      if ((res.problem as { aborted?: boolean } | undefined)?.aborted) {
        return;
      }
      if (!res.ok || !res.data) {
        setLoading(false);
        setError('Search is unavailable right now.');
        setItems([]);
        return;
      }
      setLoading(false);
      setItems(res.data.items);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, comprehensive, includeArchived, global, scopedCompany, open]);

  const goto = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  const groups = useMemo(() => groupHits(items), [items]);

  if (!open) return null;

  return (
    <div
      style={overlayStyle}
      className="search-palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <div style={shellStyle} className="search-palette-shell">
        <Command
          shouldFilter={false}
          loop
          label="Search"
          value={selected}
          onValueChange={setSelected}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        >
          <div style={headerStyle}>
            <div style={{ color: 'var(--muted)', display: 'flex' }}>
              <Icon.search size={16} />
            </div>
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder={
                scopedCompany && !global
                  ? `Search in ${scopedCompany.name}…`
                  : 'Search everything…'
              }
              style={inputStyle}
              // Stop macOS/iOS/Safari from treating this as a form
              // field and suggesting SMS verification codes (the
              // annoying "from Messages" prompt every time ⌘K opens).
              // Belt-and-braces across browsers + password managers.
              type="text"
              role="searchbox"
              name="global-search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="search"
              enterKeyHint="search"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
            />
            <Kbd>Esc</Kbd>
          </div>

          <div style={toolbarStyle}>
            <Chip
              active={!global && !!scopedCompany}
              disabled={!scopedCompany}
              title={
                scopedCompany
                  ? `Search only within ${scopedCompany.name} (Alt+G to toggle)`
                  : 'Open a company to scope searches to it'
              }
              onClick={() => scopedCompany && setGlobal((v) => !v)}
            >
              <span style={{ opacity: scopedCompany ? 1 : 0.55 }}>
                {scopedCompany
                  ? !global
                    ? `In ${trimTo(scopedCompany.name, 20)}`
                    : 'Global'
                  : 'Global'}
              </span>
              {scopedCompany ? (
                <span style={{ marginLeft: 6 }}>
                  <Kbd>Alt</Kbd>
                  <span style={{ margin: '0 2px', color: 'var(--faint)' }}>+</span>
                  <Kbd>G</Kbd>
                </span>
              ) : null}
            </Chip>
            <Chip
              active={comprehensive}
              title="Broaden matches with prefix search"
              onClick={() => setComprehensive((v) => !v)}
            >
              Comprehensive
            </Chip>
            <Chip
              active={includeArchived}
              title="Show archived (museum) items in results"
              onClick={() => setIncludeArchived((v) => !v)}
            >
              Include archived
            </Chip>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
              {loading ? (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>searching…</span>
              ) : null}
            </div>
          </div>

          <Command.List style={listStyle}>
            {query.trim().length === 0 ? (
              <EmptyState scopedCompany={scopedCompany} />
            ) : error ? (
              <div style={emptyStyle}>{error}</div>
            ) : (
              <>
                <Command.Empty style={emptyStyle}>
                  {loading ? 'Searching…' : 'No results.'}
                </Command.Empty>
                {groups.map(([kind, hits]) => (
                  <Command.Group
                    key={kind}
                    heading={groupLabel(kind)}
                    style={groupStyle}
                  >
                    {hits.map((hit) => (
                      <Command.Item
                        key={`${hit.kind}:${hit.id}`}
                        value={`${hit.kind}:${hit.id}`}
                        onSelect={() => goto(hit.href)}
                        style={itemStyle}
                      >
                        <Result hit={hit} showCompany={global} />
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </>
            )}
          </Command.List>

          <div style={footerStyle}>
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd>&nbsp; move
            </span>
            <span>
              <Kbd>↵</Kbd>&nbsp; open
            </span>
            <span>
              <Kbd>Esc</Kbd>&nbsp; close
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function Result({ hit, showCompany }: { hit: SearchHit; showCompany: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
      <KindGlyph hit={hit} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13.5,
            color: 'var(--text)',
            fontWeight: 500,
          }}
        >
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {hit.title || '(untitled)'}
          </span>
          {hit.archivedAt ? (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                textTransform: 'uppercase',
                color: 'var(--warn, #b08900)',
                letterSpacing: 0.6,
              }}
            >
              archived
            </span>
          ) : null}
        </div>
        {hit.snippet ? (
          <div style={snippetStyle}>
            <HighlightedSnippet snippet={hit.snippet} />
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 3,
            fontSize: 11.25,
            color: 'var(--muted)',
          }}
        >
          {showCompany && hit.companyName ? (
            <span style={{ color: 'var(--dim)' }}>{hit.companyName}</span>
          ) : null}
          {showCompany && hit.companyName ? <Dot /> : null}
          <span>{relativeTime(hit.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Render a ts_headline snippet with highlighted terms.
 *
 * The API pre-escapes every character in the snippet and then re-emits
 * only `<mark>` / `</mark>` as literal tags (see
 * `SearchService.sanitiseSnippet`). We split on those literals and
 * render `<mark>` as a real React element, letting React escape all
 * surrounding text. This keeps highlights working without ever
 * handing unsanitised HTML to the DOM — no `dangerouslySetInnerHTML`,
 * no DOMPurify dependency, and nothing for SAST scanners to flag.
 */
function HighlightedSnippet({ snippet }: { snippet: string }) {
  // ts_headline uses MaxFragments=1 so the snippet is a single line;
  // `.*?` is a safe non-greedy match for the contents of each <mark>.
  const parts = snippet.split(/(<mark>.*?<\/mark>)/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^<mark>(.*?)<\/mark>$/.exec(part);
        if (m) {
          return <mark key={i}>{m[1]}</mark>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function KindGlyph({ hit }: { hit: SearchHit }) {
  const size = 28;
  if (hit.kind === 'asset') {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: hit.layoutColor
            ? `color-mix(in oklab, ${hit.layoutColor} 20%, transparent)`
            : 'var(--panel-2)',
          color: hit.layoutColor ?? 'var(--muted)',
          border: '1px solid var(--line)',
          flex: '0 0 auto',
        }}
        aria-hidden
      >
        <Icon.box size={16} />
      </div>
    );
  }
  if (hit.kind === 'article') {
    return (
      <Glyph>
        <Icon.doc size={16} />
      </Glyph>
    );
  }
  if (hit.kind === 'domain') {
    return (
      <Glyph>
        <Icon.globe size={16} />
      </Glyph>
    );
  }
  return (
    <Glyph>
      <Icon.image size={16} />
    </Glyph>
  );
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        color: 'var(--muted)',
        flex: '0 0 auto',
      }}
      aria-hidden
    >
      {children}
    </div>
  );
}

function Chip({
  children,
  active,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      style={{
        ...chipBase,
        background: active
          ? 'color-mix(in oklab, var(--accent) 18%, transparent)'
          : 'var(--panel)',
        color: active ? 'var(--text)' : 'var(--muted)',
        borderColor: active ? 'var(--accent)' : 'var(--line)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function EmptyState({
  scopedCompany,
}: {
  scopedCompany: { id: string; name: string } | null;
}) {
  return (
    <div
      style={{
        padding: '28px 18px',
        color: 'var(--muted)',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <div style={{ color: 'var(--text)', fontWeight: 500, marginBottom: 6 }}>
        {scopedCompany
          ? `Search in ${scopedCompany.name}`
          : 'Search every company'}
      </div>
      Start typing to find assets, articles, files, and domains.
      <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>
          <Kbd>"quoted phrase"</Kbd>&nbsp; match exact
        </span>
        <span>
          <Kbd>-term</Kbd>&nbsp; exclude
        </span>
        <span>
          <Kbd>OR</Kbd>&nbsp; either
        </span>
      </div>
    </div>
  );
}

function Dot() {
  return (
    <span
      style={{
        width: 3,
        height: 3,
        background: 'var(--faint)',
        borderRadius: '50%',
        alignSelf: 'center',
      }}
      aria-hidden
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function groupHits(items: SearchHit[]): Array<[SearchHit['kind'], SearchHit[]]> {
  const order: SearchHit['kind'][] = ['asset', 'article', 'upload', 'domain'];
  const buckets = new Map<SearchHit['kind'], SearchHit[]>();
  for (const h of items) {
    const arr = buckets.get(h.kind) ?? [];
    arr.push(h);
    buckets.set(h.kind, arr);
  }
  return order
    .filter((k) => buckets.has(k))
    .map((k) => [k, buckets.get(k)!]);
}

function groupLabel(kind: SearchHit['kind']): string {
  switch (kind) {
    case 'asset':
      return 'Assets';
    case 'article':
      return 'Articles';
    case 'upload':
      return 'Files';
    case 'domain':
      return 'Domains';
  }
}

function trimTo(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - then);
  const sec = delta / 1000;
  if (sec < 60) return 'just now';
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)}m ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)}h ago`;
  const day = hr / 24;
  if (day < 30) return `${Math.floor(day)}d ago`;
  const mo = day / 30;
  if (mo < 12) return `${Math.floor(mo)}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// ─────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  background: 'rgba(0, 0, 0, 0.55)',
  backdropFilter: 'blur(2px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '10vh 16px 16px',
};

const shellStyle: CSSProperties = {
  width: '100%',
  maxWidth: 640,
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  overflow: 'hidden',
  boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '75vh',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px',
  borderBottom: '1px solid var(--line)',
};

const inputStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontSize: 15,
  color: 'var(--text)',
  fontFamily: 'var(--font-sans)',
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderBottom: '1px solid var(--line)',
  background: 'var(--panel-2)',
};

const chipBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 24,
  padding: '0 8px',
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 500,
  border: '1px solid var(--line)',
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
};

const listStyle: CSSProperties = {
  overflow: 'auto',
  maxHeight: '56vh',
  padding: '6px 0',
};

const emptyStyle: CSSProperties = {
  padding: '28px 18px',
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--muted)',
};

const groupStyle: CSSProperties = {
  padding: '6px 0',
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '8px 14px',
  fontSize: 13.5,
  cursor: 'pointer',
  color: 'var(--text)',
  borderRadius: 0,
};

const snippetStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 12,
  color: 'var(--dim)',
  lineHeight: 1.5,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical' as const,
  overflow: 'hidden',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'center',
  padding: '10px 14px',
  borderTop: '1px solid var(--line)',
  background: 'var(--panel-2)',
  fontSize: 11.25,
  color: 'var(--muted)',
};
