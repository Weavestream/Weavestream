import { useEffect, useRef, useState } from 'react';
import type { TagChipDraft } from '@weavestream/shared';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/primitives';
import { apiFetch } from '../../lib/api';

/**
 * Mobile tag chip input: chips above a full-width input, with the
 * autocomplete rendered as an IN-FLOW button list under the input —
 * not an absolute popover, which fights the iOS keyboard viewport.
 * Suggestions come from the global `/tags` endpoint (max 8, 180 ms
 * debounce, aborted on change); committing free text creates a `{name}`
 * draft the server upserts inside the asset-write transaction.
 *
 * Emits `TagChipDraft[]` only — the wire mapping (`toAssetWireTags`)
 * belongs to the payload builder, not this component.
 */

const DEBOUNCE_MS = 180;
const SUGGESTION_LIMIT = 8;

interface TagSuggestion {
  id: string;
  name: string;
}

export function TagsInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: TagChipDraft[];
  onChange: (next: TagChipDraft[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const taken = new Set(value.map((c) => c.name.trim().toLowerCase()));

  useEffect(() => {
    const q = draft.trim();
    if (q === '') {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      apiFetch<{ items: TagSuggestion[] }>(
        `/tags?q=${encodeURIComponent(q)}&limit=${SUGGESTION_LIMIT}`,
        { signal: ctrl.signal },
      )
        .then((res) => {
          // The aborted check closes the resolve-before-abort window: a
          // response that raced the abort must not repopulate stale
          // suggestions under a newer (or cleared) draft.
          if (!ctrl.signal.aborted) setSuggestions(res.items);
        })
        .catch(() => {
          // Aborted or failed — suggestions are a convenience, the
          // free-text commit path keeps working without them.
        });
    }, DEBOUNCE_MS);
    return () => {
      // Runs on every draft change and on unmount: kill the timer AND
      // any in-flight lookup, so an older response can never land after
      // the query it answered stopped being the query.
      clearTimeout(timer);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [draft]);

  function commit(chip: TagChipDraft) {
    const name = chip.name.trim();
    if (name === '' || taken.has(name.toLowerCase())) {
      setDraft('');
      setSuggestions([]);
      return;
    }
    onChange([...value, { ...chip, name }]);
    setDraft('');
    setSuggestions([]);
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  const visibleSuggestions = suggestions.filter(
    (s) => !taken.has(s.name.trim().toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-1.75">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.75">
          {value.map((chip, i) => (
            <span
              key={chip.id ?? `new-${chip.name}-${i}`}
              className={
                'flex items-center gap-1 rounded-chip py-0.5 pl-2.25 text-[13px] font-medium ' +
                (chip.id ? 'bg-panel-2 text-text-2' : 'bg-accent-soft text-accent-deep')
              }
            >
              <span className="max-w-[180px] truncate">{chip.name}</span>
              <button
                type="button"
                aria-label={`Remove tag ${chip.name}`}
                disabled={disabled}
                onClick={() => removeAt(i)}
                className="flex items-center justify-center rounded-pill text-muted active:text-text"
                // The 44pt global button floor gives this its tap size.
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        id={id}
        type="text"
        value={draft}
        disabled={disabled}
        placeholder="Add tag…"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const exact = visibleSuggestions.find(
              (s) => s.name.toLowerCase() === draft.trim().toLowerCase(),
            );
            commit(exact ?? { name: draft });
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            removeAt(value.length - 1);
          }
        }}
        onBlur={() => {
          if (draft.trim() !== '') commit({ name: draft });
        }}
      />

      {visibleSuggestions.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-field border border-line bg-surface">
          {visibleSuggestions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              // Fires before the input's blur commits the raw draft.
              onPointerDown={(e) => {
                e.preventDefault();
                commit({ id: s.id, name: s.name });
              }}
              className={
                'flex h-tap items-center px-4 text-left text-body text-text active:bg-panel-2' +
                (i > 0 ? ' border-t border-line' : '')
              }
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
