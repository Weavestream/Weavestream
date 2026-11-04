import type { ReactNode } from 'react';

/**
 * Selectable option cards. Every radio or checkbox drawn as a card uses one
 * of these two — they share the `.ws-choice` classes in `app/globals.css`, so
 * the selected state looks the same on every page. Do not hand-roll a card
 * with its own border/fill, and do not pass a `className` that changes the
 * colors.
 *
 * - `RadioOption`: one choice in a group. Group several under a `fieldset`
 *   with a shared `name`.
 * - `CheckboxOption`: one on/off preference or switch.
 *
 * For a bare inline checkbox inside a dialog form, use `Checkbox`.
 */

type BaseProps = {
  checked: boolean;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  /** Tighter padding for dialogs; the default meets the 44 px tap target. */
  dense?: boolean;
  /** Layout only (grid sizing, min-height) — never colors. */
  className?: string;
};

function ChoiceOption({
  type,
  name,
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  dense = false,
  className,
}: BaseProps & {
  type: 'radio' | 'checkbox';
  name?: string;
  onChange: (next: boolean) => void;
}) {
  const classes = ['ws-choice', dense ? 'ws-choice--dense' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <label className={classes}>
      <input
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="ws-choice-input"
      />
      <span className="ws-choice-text">
        <span className="ws-choice-label">{label}</span>
        {hint ? <span className="ws-choice-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function RadioOption({
  name,
  onChange,
  ...rest
}: BaseProps & { name: string; onChange: () => void }) {
  return <ChoiceOption type="radio" name={name} onChange={() => onChange()} {...rest} />;
}

export function CheckboxOption({
  onChange,
  ...rest
}: BaseProps & { onChange: (next: boolean) => void }) {
  return <ChoiceOption type="checkbox" onChange={onChange} {...rest} />;
}
