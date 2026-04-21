import type { CSSProperties } from 'react';

export function WeavestreamLogo({
  size = 14,
  muted = false,
}: {
  size?: number;
  muted?: boolean;
}) {
  const root: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'baseline',
    fontFamily: 'var(--font-display)',
    fontSize: size,
    fontWeight: 600,
    letterSpacing: -0.2,
    lineHeight: 1,
    color: muted ? 'var(--muted)' : 'var(--text)',
  };
  const brand: CSSProperties = {
    fontStyle: 'italic',
    fontWeight: 700,
    color: 'var(--accent)',
    paddingRight: 1,
  };
  const stream: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontWeight: 400,
    color: 'var(--muted)',
    fontSize: size * 0.9,
  };
  return (
    <span style={root}>
      <span style={brand}>Weave</span>
      <span style={stream}>stream</span>
    </span>
  );
}
