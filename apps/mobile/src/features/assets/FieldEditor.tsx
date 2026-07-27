import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { Chip, Input } from '../../components/primitives';
import { Hint } from '../../components/FieldBlock';
import type { LayoutFieldRecord } from './api';
import type { FieldEditorValue } from './field-values';

/**
 * Scalar editors for the dynamic asset form — everything that doesn't
 * own network calls (TAGS, ASSET_REFERENCE, FILE live in their own
 * files). One switch, not 17 files: each scalar editor is a handful of
 * input attributes.
 *
 * Technical fields (EMAIL/PHONE/URL/IP) use the left-aligned mono
 * override class, NOT the `Input mono` prop — that prop is the
 * centered 0.2em-tracked OTP style (PasswordFormScreen precedent).
 */

const MONO_LEFT = 'text-left font-mono tracking-normal';

const NO_ASSIST = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

export function ScalarFieldEditor({
  field,
  id,
  value,
  onChange,
  disabled,
}: {
  field: LayoutFieldRecord;
  id: string;
  value: FieldEditorValue;
  onChange: (next: FieldEditorValue) => void;
  disabled?: boolean;
}) {
  if (value.kind === 'boolean') {
    return (
      <BooleanSwitch
        id={id}
        on={value.on}
        disabled={disabled}
        onToggle={() => onChange({ kind: 'boolean', on: !value.on })}
      />
    );
  }

  if (value.kind === 'dropdown') {
    return (
      <DropdownSelect
        field={field}
        id={id}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (value.kind === 'multiselect') {
    return (
      <MultiselectChips
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (value.kind !== 'text') return null;

  const setText = (text: string) => onChange({ kind: 'text', text });

  if (field.fieldType === 'TEXTAREA') {
    return (
      <textarea
        id={id}
        value={value.text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        disabled={disabled}
        className={
          'w-full rounded-field border border-line bg-surface px-4 py-3 ' +
          'text-body text-text outline-none placeholder:text-dim ' +
          'focus:border-2 focus:border-accent'
        }
      />
    );
  }

  switch (field.fieldType) {
    case 'NUMBER':
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step="any"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
        />
      );
    case 'DATE':
      return (
        <Input
          id={id}
          type="date"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
        />
      );
    case 'DATETIME':
      return (
        <Input
          id={id}
          type="datetime-local"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
        />
      );
    case 'EMAIL':
      return (
        <Input
          id={id}
          type="email"
          inputMode="email"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          className={MONO_LEFT}
          disabled={disabled}
          {...NO_ASSIST}
        />
      );
    case 'PHONE':
      return (
        <Input
          id={id}
          type="tel"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          className={MONO_LEFT}
          disabled={disabled}
        />
      );
    case 'URL':
      return (
        <Input
          id={id}
          type="url"
          inputMode="url"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          placeholder="https://…"
          className={MONO_LEFT}
          disabled={disabled}
          {...NO_ASSIST}
        />
      );
    case 'IP_ADDRESS':
      return (
        <Input
          id={id}
          type="text"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          // Never inputMode="numeric" — the iOS numeric pad has no
          // `.`, `:` or letters, which locks out both IP families.
          placeholder={ipPlaceholder(field.options)}
          className={MONO_LEFT}
          disabled={disabled}
          {...NO_ASSIST}
        />
      );
    default:
      return (
        <Input
          id={id}
          type="text"
          value={value.text}
          onChange={(e) => setText(e.target.value)}
          maxLength={field.fieldType === 'TEXT' ? 10_000 : undefined}
          disabled={disabled}
        />
      );
  }
}

function ipPlaceholder(options: Record<string, unknown>): string {
  const version = options['version'];
  const cidr = options['allowCidr'] === true;
  if (version === 'v4') return cidr ? '10.0.0.0/24' : '192.168.1.10';
  if (version === 'v6') return cidr ? '2001:db8::/48' : '2001:db8::1';
  return cidr ? '10.0.0.0/24 or 2001:db8::/48' : '10.0.0.5 or 2001:db8::1';
}

/** 44pt switch row — `role="switch"`, label handled by FieldBlock. */
function BooleanSwitch({
  id,
  on,
  disabled,
  onToggle,
}: {
  id: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className="flex h-tap w-fit items-center gap-3"
    >
      <span
        aria-hidden
        className={
          'flex h-[30px] w-[52px] shrink-0 items-center rounded-pill p-[3px] transition-colors ' +
          (on ? 'justify-end bg-accent' : 'justify-start bg-line')
        }
      >
        <span className="h-6 w-6 rounded-pill bg-surface shadow-sm" />
      </span>
      <span className="text-body text-text">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

const OTHER_SENTINEL = '__other__';

/**
 * Native `<select>` styled like `Input` — the OS picker is the best
 * mobile dropdown there is. Out-of-catalog seeded values are injected
 * as a selectable option so the seed round-trips; `allowOther` adds an
 * `Other…` option that swaps to a free-text input.
 */
function DropdownSelect({
  field,
  id,
  value,
  onChange,
  disabled,
}: {
  field: LayoutFieldRecord;
  id: string;
  value: Extract<FieldEditorValue, { kind: 'dropdown' }>;
  onChange: (next: FieldEditorValue) => void;
  disabled?: boolean;
}) {
  const choices = readChoices(field.options);
  const allowOther = field.options['allowOther'] === true;
  const knownSlugs = new Set(choices.map((c) => c.slug));

  if (value.other) {
    return (
      <div className="flex flex-col gap-1.75">
        <Input
          id={id}
          type="text"
          value={value.otherText}
          maxLength={200}
          onChange={(e) =>
            onChange({ kind: 'dropdown', other: true, choice: '', otherText: e.target.value })
          }
          placeholder="Custom value"
          disabled={disabled}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange({ kind: 'dropdown', other: false, choice: '', otherText: '' })
          }
          className="h-tap w-fit text-[13px] font-medium text-accent-text"
        >
          Choose from list instead
        </button>
      </div>
    );
  }

  return (
    <span className="relative block">
      <select
        id={id}
        value={value.choice}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER_SENTINEL) {
            onChange({ kind: 'dropdown', other: true, choice: '', otherText: '' });
          } else {
            onChange({ kind: 'dropdown', other: false, choice: next, otherText: '' });
          }
        }}
        className={
          'h-[50px] w-full appearance-none rounded-field border border-line ' +
          'bg-surface px-4 pr-11 text-body text-text outline-none ' +
          'focus:border-2 focus:border-accent'
        }
      >
        <option value="">—</option>
        {value.choice !== '' && !knownSlugs.has(value.choice) && (
          <option value={value.choice}>{`${value.choice} (not in list)`}</option>
        )}
        {choices.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.label}
          </option>
        ))}
        {allowOther && <option value={OTHER_SENTINEL}>Other…</option>}
      </select>
      <Icon
        name="expand_more"
        size={22}
        className="pointer-events-none absolute right-3.25 top-1/2 -translate-y-1/2 text-muted"
      />
    </span>
  );
}

/**
 * Toggle-chip bag (the desktop MULTISELECT translated to 44pt chips).
 * Stored-but-unknown slugs render as removable chips too — toggling
 * one off is the only way to shed a legacy value. `maxSelections`
 * disables the unselected rest with an n/max hint.
 */
function MultiselectChips({
  field,
  value,
  onChange,
  disabled,
}: {
  field: LayoutFieldRecord;
  value: Extract<FieldEditorValue, { kind: 'multiselect' }>;
  onChange: (next: FieldEditorValue) => void;
  disabled?: boolean;
}) {
  const choices = readChoices(field.options);
  const max =
    typeof field.options['maxSelections'] === 'number'
      ? (field.options['maxSelections'] as number)
      : null;
  const knownSlugs = new Set(choices.map((c) => c.slug));
  const extras = value.slugs.filter((s) => !knownSlugs.has(s));
  const atMax = max !== null && value.slugs.length >= max;

  const toggle = (slug: string) => {
    const active = value.slugs.includes(slug);
    onChange({
      kind: 'multiselect',
      slugs: active ? value.slugs.filter((s) => s !== slug) : [...value.slugs, slug],
    });
  };

  return (
    <div className="flex flex-col gap-1.75">
      <div className="flex flex-wrap gap-2">
        {choices.map((c) => {
          const active = value.slugs.includes(c.slug);
          return (
            <Chip
              key={c.slug}
              active={active}
              disabled={disabled || (!active && atMax)}
              onClick={() => toggle(c.slug)}
            >
              {c.label}
            </Chip>
          );
        })}
        {extras.map((slug) => (
          <Chip key={slug} active disabled={disabled} onClick={() => toggle(slug)}>
            {slug}
          </Chip>
        ))}
      </div>
      {max !== null && (
        <Hint>
          {value.slugs.length}/{max} selected
        </Hint>
      )}
    </div>
  );
}

function readChoices(
  options: Record<string, unknown>,
): Array<{ slug: string; label: string }> {
  const raw = options['choices'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as { slug?: unknown }).slug === 'string' &&
      typeof (c as { label?: unknown }).label === 'string'
    ) {
      return [{ slug: (c as { slug: string }).slug, label: (c as { label: string }).label }];
    }
    return [];
  });
}

/**
 * Read-only display wrapper for RICH_TEXT / VAULTWARDEN_LINK / unknown
 * types inside the form — never hidden (a field silently absent is how
 * a technician comes to believe they saved a complete record), never
 * serialized (omission preserves the stored value).
 */
export function ReadonlyField({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.75">
      {children}
      <Hint>View only on mobile — edit this field on desktop.</Hint>
    </div>
  );
}
