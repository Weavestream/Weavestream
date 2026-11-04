/**
 * Plain inline checkbox with a label and optional hint line — the
 * dialog-form boolean control. Distinct from `CheckboxOption`, the card-styled
 * option control in `choice-option.tsx`: this one is bare,
 * for stacking inside dialog forms.
 *
 * Lifted out of the alerts and backups admin clients, which each carried
 * an identical local copy (`Checkbox` / `CheckboxRow`).
 */
export function Checkbox({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        fontSize: 13,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, accentColor: 'var(--accent)' }}
      />
      <span style={{ flex: 1 }}>
        {label}
        {hint && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {hint}
          </div>
        )}
      </span>
    </label>
  );
}
