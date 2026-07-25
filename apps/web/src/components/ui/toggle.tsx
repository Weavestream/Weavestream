/**
 * Checkbox rendered as a labelled card — the boolean-preference control
 * used across `/me` (search defaults, sidebar density).
 *
 * Lifted out of `me/profile-form.tsx`, where it was local, when the
 * Appearance panel needed the same control. Same markup and metrics, one
 * fix: the border read `var(--border)`, which is defined nowhere in the
 * token set, so the whole `border` shorthand went invalid at
 * computed-value time and collapsed to `border-style: none` — these
 * cards have never actually drawn the border they were written to have.
 * `--line-2` is the token that matches their intent.
 */
export function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 12px',
        border: '1px solid var(--line-2)',
        borderRadius: 10,
        cursor: 'pointer',
        background: checked
          ? 'color-mix(in oklab, var(--accent) 10%, transparent)'
          : 'transparent',
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, accentColor: 'var(--accent)' }}
      />
      <span style={{ display: 'grid', gap: 2 }}>
        <span style={{ fontSize: 13.5, color: 'var(--text)', fontWeight: 500 }}>
          {label}
        </span>
        {help ? (
          <span style={{ fontSize: 12, color: 'var(--dim)' }}>{help}</span>
        ) : null}
      </span>
    </label>
  );
}
