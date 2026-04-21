export function CompanyMark({
  name,
  color = 'var(--info)',
  size = 22,
  square = true,
}: {
  name: string;
  color?: string;
  size?: number;
  square?: boolean;
}) {
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: square ? 4 : '50%',
        background: `color-mix(in oklch, ${color} 18%, transparent)`,
        color,
        fontSize: size * 0.4,
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        display: 'grid',
        placeItems: 'center',
        border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}
