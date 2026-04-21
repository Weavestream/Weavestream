export function Stat({
  label,
  value,
  delta,
  mono = true,
}: {
  label: string;
  value: string | number;
  delta?: string;
  mono?: boolean;
}) {
  const deltaColor = delta?.startsWith('-')
    ? 'var(--danger)'
    : delta?.startsWith('+')
      ? 'var(--ok)'
      : 'var(--muted)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: 0.5,
          color: 'var(--muted)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-display)',
          fontSize: 22,
          fontWeight: 500,
          letterSpacing: -0.5,
          color: 'var(--text)',
        }}
      >
        {value}
      </div>
      {delta && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: deltaColor,
          }}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
