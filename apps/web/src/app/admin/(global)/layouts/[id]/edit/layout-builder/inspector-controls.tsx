/**
 * Form primitives shared by the field inspector and the per-type
 * options editors.
 */

export const inspectorInputStyle = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: '6px 8px',
  fontSize: 12.5,
  color: 'var(--text)',
  outline: 'none',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box' as const,
};

export function InspectorField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

export function InspectorInput({
  label,
  value,
  onChange,
  mono,
  readOnly,
  help,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  readOnly?: boolean;
  help?: string;
  placeholder?: string;
}) {
  return (
    <InspectorField label={label} hint={help}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        placeholder={placeholder}
        className="inp"
        style={{
          ...inspectorInputStyle,
          ...(mono ? { fontFamily: 'var(--font-mono)' } : {}),
          ...(readOnly ? { color: 'var(--muted)' } : {}),
        }}
      />
    </InspectorField>
  );
}

export function ToggleRow({
  label,
  value,
  onChange,
  disabled,
  help,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  help?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '6px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1, fontSize: 12.5 }}>{label}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(!value)}
          aria-pressed={value}
          style={{
            width: 28,
            height: 16,
            borderRadius: 9,
            background: value ? 'var(--accent-fill)' : 'var(--line-3)',
            position: 'relative',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            transition: 'background 160ms ease',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 1,
              left: value ? 14 : 1,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: value ? 'var(--accent-fill-ink)' : 'var(--text-2)',
              transition: 'left 160ms ease',
            }}
          />
        </button>
      </div>
      {help && (
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
            marginTop: 3,
          }}
        >
          {help}
        </span>
      )}
    </div>
  );
}
