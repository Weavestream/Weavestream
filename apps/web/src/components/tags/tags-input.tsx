'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Icon, Tag } from '../ui';
import { apiFetch } from '../../lib/api';

/**
 * Reusable autocompleting tag chip input. Extracted from the asset
 * form so both the dynamic asset TAGS field and the password vault
 * dialogs can share the same UX (chips, debounced `/tags` lookup,
 * Enter/comma to commit, Backspace to delete). Wire-format
 * serialization is left to the caller — the input always operates on
 * the internal `TagChipDraft` shape — see `toAssetWireTags` (id-or-
 * name resolution) and `toPlainNameList` (names only) below.
 */

/**
 * The chip shape and wire serializers moved to
 * `@weavestream/shared/tag-chips` in Phase 2c so the mobile TAGS editor
 * shares them. Re-exported here so existing import sites are unchanged —
 * new code may import them from `@weavestream/shared` directly.
 */
export {
  coerceTagChips,
  toAssetWireTags,
  toPlainNameList,
  type TagChipDraft,
} from '@weavestream/shared';
import type { TagChipDraft } from '@weavestream/shared';

type TagSuggestion = { id: string; name: string };

const DEFAULT_CONTROL_STYLE: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line-2)',
  borderRadius: 4,
  padding: '7px 10px',
  fontSize: 13,
  color: 'var(--text)',
  outline: 'none',
  width: '100%',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

export function TagsInput({
  value,
  onChange,
  disabled,
  controlStyle = DEFAULT_CONTROL_STYLE,
  placeholder = 'add tag…',
}: {
  value: TagChipDraft[];
  onChange: (next: TagChipDraft[]) => void;
  disabled?: boolean;
  /** Optional override for the outer chip wrapper styling. */
  controlStyle?: CSSProperties;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounced autocomplete fetch against the global Tag list.
  useEffect(() => {
    const q = draft.trim();
    if (!open || q.length === 0) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const res = await apiFetch<{ items: TagSuggestion[] }>(
        `/tags?q=${encodeURIComponent(q)}&limit=8`,
        { signal: ctrl.signal },
      );
      if (!res.ok || !res.data) return;
      const taken = new Set(value.map((c) => c.id).filter(Boolean) as string[]);
      const filtered = res.data.items.filter((s) => !taken.has(s.id));
      setSuggestions(filtered);
      setHighlight(0);
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [draft, open, value]);

  // Close the suggestion dropdown when the user clicks outside the chip
  // wrapper. We don't rely on `onBlur` alone because a click on a suggestion
  // would fire blur first and lose the click target.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function commitName(name: string) {
    const t = name.trim();
    if (!t) return;
    const lower = t.toLowerCase();
    if (value.some((c) => c.name.toLowerCase() === lower)) {
      setDraft('');
      return;
    }
    onChange([...value, { name: t }]);
    setDraft('');
  }

  function commitSuggestion(s: TagSuggestion) {
    if (value.some((c) => c.id === s.id)) {
      setDraft('');
      return;
    }
    onChange([...value, { id: s.id, name: s.name }]);
    setDraft('');
    setSuggestions([]);
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div
      ref={wrapperRef}
      style={{ position: 'relative' }}
      onClick={() => inputRef.current?.focus()}
    >
      <div
        style={{
          ...controlStyle,
          padding: 6,
          display: 'flex',
          gap: 5,
          flexWrap: 'wrap',
          alignItems: 'center',
          minHeight: 32,
        }}
      >
        {value.map((chip, i) => (
          <Tag
            key={chip.id ?? `new-${i}-${chip.name}`}
            tone={chip.id ? 'outline' : 'info'}
            style={{ height: 20 }}
          >
            {chip.name}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(i);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                  marginLeft: 3,
                }}
                aria-label={`Remove tag ${chip.name}`}
              >
                <Icon.x size={9} />
              </button>
            )}
          </Tag>
        ))}
        <input
          ref={inputRef}
          value={draft}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            // Stop keys we consume from bubbling — otherwise an
            // outer dialog/form listener (e.g. Enter-to-submit on
            // the password edit dialog, Escape-to-close on the
            // shared `Dialog` shell) would fire on the same event
            // and the user's tag commit would also submit/close
            // the surrounding form.
            if (e.key === 'ArrowDown') {
              if (suggestions.length === 0) return;
              e.preventDefault();
              e.stopPropagation();
              setHighlight((h) => (h + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp') {
              if (suggestions.length === 0) return;
              e.preventDefault();
              e.stopPropagation();
              setHighlight(
                (h) => (h - 1 + suggestions.length) % suggestions.length,
              );
            } else if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              e.stopPropagation();
              const pick = suggestions[highlight];
              if (pick && draft.trim()) {
                commitSuggestion(pick);
              } else {
                commitName(draft);
              }
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              e.stopPropagation();
              removeAt(value.length - 1);
            }
          }}
          onBlur={() => {
            // Don't auto-commit on blur — the click-outside handler closes
            // the dropdown, and the user can still hit Enter to keep what
            // they typed. Commit only if they typed something but never
            // selected a suggestion.
            if (draft.trim()) commitName(draft);
          }}
          placeholder={value.length === 0 ? placeholder : ''}
          style={{
            flex: 1,
            minWidth: 90,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 12.5,
            color: 'var(--text)',
            padding: '4px 2px',
          }}
        />
      </div>
      {open && draft.trim() && suggestions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 2,
            background: 'var(--panel)',
            border: '1px solid var(--line-2)',
            borderRadius: 4,
            boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
            zIndex: 50,
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commitSuggestion(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: 12.5,
                background: i === highlight ? 'var(--accent-soft)' : 'transparent',
                color: i === highlight ? 'var(--accent)' : 'var(--text)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
