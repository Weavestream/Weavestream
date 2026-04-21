'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Icon } from '../../components/ui';
import { Input } from '../../components/ui';

/**
 * IANA timezone picker for the /me profile form.
 *
 * The raw text input that shipped originally was faster to build but
 * accepted any free-form string, so a typo like `Europe/Berln` would
 * silently save and then rendered date columns in UTC. This component
 * restricts the value to the runtime's canonical IANA list
 * (`Intl.supportedValuesOf('timeZone')`) and annotates each row with
 * the current UTC offset so "Europe/Berlin (UTC+2)" is self-evident.
 *
 * Behaviour notes:
 * - The trigger is always an input. A non-empty `value` seeds the
 *   input but clicking or focusing puts it back into search mode;
 *   that keeps keyboard-only flows simple (Tab in, type, Enter).
 * - Keyboard: ArrowDown/Up move the highlight, Enter selects,
 *   Escape closes without changes. We also scroll the highlighted row
 *   into view so PageDown / long lists don't feel broken.
 * - Empty string = "no preference" on the server side; the caller
 *   decides what to do with that (profile-form sends `null`).
 */
const TIMEZONES: string[] = getTimezones();

function getTimezones(): string[] {
  if (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl) {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] })
        .supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Formatted UTC offset for `zone` at the current moment
 * (e.g. "UTC+2", "UTC-5:30"). Swallows invalid zones so the picker
 * never crashes on an obscure entry the runtime lies about.
 */
function offsetLabel(zone: string, at: Date): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    });
    const parts = dtf.formatToParts(at);
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    // Normalise "GMT" → "UTC" for consistency with the rest of the app
    // (settings pages speak UTC). Bare "GMT" becomes "UTC".
    if (offset === 'GMT') return 'UTC';
    return offset.replace(/^GMT/, 'UTC');
  } catch {
    return '';
  }
}

export interface TimezonePickerProps {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  placeholder?: string;
}

export function TimezonePicker({
  value,
  onChange,
  id,
  placeholder = 'Search timezones…',
}: TimezonePickerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const generatedId = useId();
  const listboxId = id ? `${id}-listbox` : `${generatedId}-listbox`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  // Recompute offsets once per mount — the UI is OK with a snapshot
  // (DST boundaries aren't going to shift while this picker is open).
  const now = useMemo(() => new Date(), []);

  // Browser's resolved zone, surfaced as a one-click suggestion when
  // the search box is empty — the single most common "correct" answer
  // for a new user, so it's worth the top slot.
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return null;
    }
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TIMEZONES.slice(0, 250); // cap the unfiltered list so the popover opens fast
    return TIMEZONES.filter((z) => z.toLowerCase().includes(q)).slice(0, 250);
  }, [query]);

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
    // Whenever the filtered list changes, snap the highlight back to
    // the first row so Enter always selects the most relevant match
    // rather than a stale index pointing past the end of the list.
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const node = list.querySelector<HTMLElement>(
      `[data-tz-index="${highlight}"]`,
    );
    if (node) node.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  function commit(next: string) {
    onChange(next);
    setOpen(false);
    setQuery('');
    // Returning focus to the input is important for keyboard users;
    // without this Tab would hop to the next form field before the
    // user has seen the new value land in the trigger.
    inputRef.current?.blur();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[highlight];
      if (pick) commit(pick);
    }
  }

  const hasValue = value.trim().length > 0;
  const displayValue = open ? query : value;

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
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
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          placeholder={hasValue ? value : placeholder}
          value={displayValue}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          style={{ paddingLeft: 30, paddingRight: hasValue ? 60 : 30 }}
        />
        {hasValue && !open && (
          <span
            style={{
              position: 'absolute',
              right: 30,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              pointerEvents: 'none',
            }}
          >
            {offsetLabel(value, now)}
          </span>
        )}
        {hasValue && (
          <button
            type="button"
            onClick={() => {
              commit('');
              inputRef.current?.focus();
            }}
            aria-label="Clear timezone"
            style={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: 4,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <Icon.x size={12} />
          </button>
        )}
      </div>
      {open && (
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
          {browserZone && !query && browserZone !== value && (
            <button
              type="button"
              onClick={() => commit(browserZone)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--line)',
                color: 'var(--text)',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 12.5,
              }}
            >
              <Icon.globe size={12} style={{ color: 'var(--accent)' }} />
              <span style={{ flex: 1 }}>
                Use browser timezone{' '}
                <span style={{ color: 'var(--dim)' }}>— {browserZone}</span>
              </span>
              <span
                style={{
                  color: 'var(--dim)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}
              >
                {offsetLabel(browserZone, now)}
              </span>
            </button>
          )}
          {results.length === 0 ? (
            <div
              style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}
            >
              No timezones match &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {results.map((zone, i) => {
                const active = i === highlight;
                const selected = zone === value;
                return (
                  <li key={zone} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-tz-index={i}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => commit(zone)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        padding: '7px 12px',
                        background: active ? 'var(--panel-2)' : 'transparent',
                        border: 'none',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        fontSize: 12.5,
                        textAlign: 'left',
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {zone.replace(/_/g, ' ')}
                      </span>
                      <span
                        style={{
                          color: 'var(--dim)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                        }}
                      >
                        {offsetLabel(zone, now)}
                      </span>
                      {selected && (
                        <Icon.check
                          size={12}
                          style={{ color: 'var(--accent)' }}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
