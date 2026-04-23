'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../../../../components/ui';

/**
 * Picker for `DROPDOWN` field values. Supports two modes:
 * - Standard mode (allowOther=false): simple <select> dropdown
 * - "Allow Other" mode (allowOther=true): combobox that allows both
 *   selecting predefined choices AND entering free text
 */

type Choice = {
  slug: string;
  label: string;
};

type Props = {
  choices: Choice[];
  allowOther: boolean;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  controlStyle: CSSProperties;
};

export function DropdownPicker({
  choices,
  allowOther,
  value,
  onChange,
  disabled,
  controlStyle,
}: Props) {
  // Standard mode: use native <select>
  if (!allowOther) {
    return (
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        style={controlStyle}
      >
        <option value="">— select —</option>
        {choices.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }

  // Allow Other mode: combobox with free text entry
  return (
    <AllowOtherDropdown
      choices={choices}
      value={value}
      onChange={onChange}
      disabled={disabled}
      controlStyle={controlStyle}
    />
  );
}

function AllowOtherDropdown({
  choices,
  value,
  onChange,
  disabled,
  controlStyle,
}: Omit<Props, 'allowOther'>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [popoverRect, setPopoverRect] = useState<
    { left: number; top: number; width: number } | null
  >(null);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Build filtered list based on query
  const filteredChoices = useMemo(() => {
    if (!query.trim()) return choices;
    const q = query.toLowerCase();
    return choices.filter(
      (c) => c.label.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q)
    );
  }, [choices, query]);

  // Check if current value matches a choice
  const selectedChoice = useMemo(() => {
    if (!value) return null;
    return choices.find((c) => c.slug === value) ?? null;
  }, [choices, value]);

  // Is current value a custom "other" value (not matching any choice)?
  const isOtherValue = value !== null && selectedChoice === null;

  // Anchor the popover under the trigger
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const measure = () => {
      const rect = anchorRef.current!.getBoundingClientRect();
      setPopoverRect({
        left: rect.left,
        top: rect.bottom + 4,
        width: Math.max(rect.width, 220),
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (anchorRef.current?.contains(tgt)) return;
      if (popoverRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Focus input when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
      setActiveIndex(0);
      // Pre-populate query with current value if it's a custom value
      if (isOtherValue && value) {
        setQuery(value);
      } else {
        setQuery('');
      }
    }
  }, [open, isOtherValue, value]);

  const selectChoice = useCallback(
    (slug: string) => {
      onChange(slug);
      setOpen(false);
      setQuery('');
    },
    [onChange]
  );

  const selectCustomValue = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed) {
      onChange(trimmed);
    } else {
      onChange(null);
    }
    setOpen(false);
    setQuery('');
  }, [query, onChange]);

  const clearValue = useCallback(() => {
    onChange(null);
    setQuery('');
  }, [onChange]);

  const onAnchorKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPopoverKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % (filteredChoices.length + 1)); // +1 for "Use custom" option
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(
        (i) => (i - 1 + (filteredChoices.length + 1)) % (filteredChoices.length + 1)
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex < filteredChoices.length) {
        const choice = filteredChoices[activeIndex];
        if (choice) selectChoice(choice.slug);
      } else {
        // "Use custom" option
        selectCustomValue();
      }
    }
  };

  const displayLabel = selectedChoice?.label ?? value ?? '';

  return (
    <>
      <div
        ref={anchorRef}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onAnchorKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...controlStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 8px',
          minHeight: 34,
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {value ? (
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayLabel}
            {isOtherValue && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  color: 'var(--dim)',
                  fontFamily: 'var(--font-mono)',
                }}
              >(custom)</span>
            )}
          </span>
        ) : (
          <span style={{ color: 'var(--dim)', fontSize: 12.5 }}>— select —</span>
        )}
        <span style={{ flex: 1 }} />
        {value && !disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clearValue();
            }}
            aria-label="Clear"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              padding: 2,
              cursor: 'pointer',
              color: 'var(--dim)',
            }}
          >
            <Icon.x size={10} />
          </button>
        )}
        <Icon.caret
          size={9}
          style={{
            color: 'var(--dim)',
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 140ms ease',
          }}
        />
      </div>

      {open && popoverRect && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popoverRef}
              role="listbox"
              onKeyDown={onPopoverKey}
              tabIndex={-1}
              style={{
                position: 'fixed',
                left: popoverRect.left,
                top: popoverRect.top,
                width: popoverRect.width,
                maxHeight: 320,
                background: 'var(--panel)',
                border: '1px solid var(--line-2)',
                borderRadius: 6,
                boxShadow: 'var(--shadow-2)',
                zIndex: 1000,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* Search/Input area */}
              <div
                style={{
                  padding: 6,
                  borderBottom: '1px solid var(--line)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Icon.search size={12} style={{ color: 'var(--dim)' }} />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIndex(0);
                  }}
                  placeholder="Search or type custom value…"
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: 'var(--text)',
                    fontSize: 12.5,
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              {/* Choices list */}
              <div
                style={{
                  overflow: 'auto',
                  maxHeight: 240,
                  padding: 4,
                }}
              >
                {filteredChoices.length === 0 && !query.trim() && (
                  <div
                    style={{
                      padding: '10px 12px',
                      color: 'var(--muted)',
                      fontSize: 12.5,
                    }}
                  >
                    No options available
                  </div>
                )}

                {filteredChoices.map((choice, i) => {
                  const isSelected = value === choice.slug;
                  const isActive = i === activeIndex;
                  return (
                    <button
                      key={choice.slug}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => selectChoice(choice.slug)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        borderRadius: 4,
                        background: isActive
                          ? 'var(--panel-2)'
                          : isSelected
                            ? 'var(--accent-soft)'
                            : 'transparent',
                        border: 'none',
                        color: isSelected ? 'var(--accent)' : 'var(--text)',
                        fontSize: 12.5,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        style={{
                          width: 14,
                          display: 'inline-flex',
                          justifyContent: 'center',
                          color: isSelected ? 'var(--accent)' : 'transparent',
                        }}
                      >
                        <Icon.check size={11} />
                      </span>
                      <span
                        style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {choice.label}
                      </span>
                    </button>
                  );
                })}

                {/* "Use custom value" option - only show if query doesn't match exactly */}
                {query.trim() && !filteredChoices.find((c) => c.slug === query.trim()) && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === query.trim()}
                    onMouseEnter={() => setActiveIndex(filteredChoices.length)}
                    onClick={() => selectCustomValue()}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      borderRadius: 4,
                      background:
                        activeIndex === filteredChoices.length
                          ? 'var(--panel-2)'
                          : value === query.trim()
                            ? 'var(--accent-soft)'
                            : 'transparent',
                      border: 'none',
                      color:
                        value === query.trim() ? 'var(--accent)' : 'var(--text)',
                      fontSize: 12.5,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      textAlign: 'left',
                      borderTop:
                        filteredChoices.length > 0
                          ? '1px solid var(--line)'
                          : 'none',
                      marginTop: filteredChoices.length > 0 ? 4 : 0,
                    }}
                  >
                    <span
                      style={{
                        width: 14,
                        display: 'inline-flex',
                        justifyContent: 'center',
                        color: value === query.trim() ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      <Icon.check size={11} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontStyle: 'italic',
                      }}
                    >
                      Use &quot;{query.trim()}&quot;
                    </span>
                  </button>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
