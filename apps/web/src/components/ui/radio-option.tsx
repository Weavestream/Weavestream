import type { ReactNode } from 'react';

/**
 * One choice in a radio group, drawn as a labelled card: the accent border
 * marks the selected one. Group several under a `fieldset` with a shared
 * `name`.
 *
 * Lifted out of the OAuth consent page and the folder settings dialog, which
 * each had a local copy. `dense` keeps the dialog's tighter padding; the
 * default meets the 44 px tap target.
 */
export function RadioOption({
  name,
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  dense = false,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  hint: ReactNode;
  disabled?: boolean;
  dense?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: dense ? '8px 10px' : '10px 12px',
        minHeight: dense ? undefined : 44,
        border: `1px solid ${checked ? 'var(--accent-line)' : 'var(--line)'}`,
        background: checked ? 'var(--panel-2)' : 'transparent',
        borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{ accentColor: 'var(--accent)', marginTop: 2 }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</span>
      </span>
    </label>
  );
}
