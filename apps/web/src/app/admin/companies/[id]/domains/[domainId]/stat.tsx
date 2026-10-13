/** Label / value / optional sub-line cell used by the domain detail panels. */
export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.3,
          color: 'var(--dim)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 15, color: 'var(--text)' }}>{value}</span>
      {sub && (
        <span
          style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}
        >
          {sub}
        </span>
      )}
    </div>
  );
}
