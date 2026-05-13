'use client';

import { percentToTier, tierToTone } from './score-card';

/**
 * 30-point sparkline of recent percent scores. Renders a small SVG;
 * we deliberately avoid a charting dependency to keep the bundle
 * small. Falls back to a muted placeholder when fewer than 2 scored
 * checks are available.
 */
export function ScoreSparkline({
  scores,
  width = 140,
  height = 28,
}: {
  scores: Array<number | null>;
  width?: number;
  height?: number;
}) {
  const values = scores.filter((v): v is number => typeof v === 'number');
  if (values.length < 2) {
    return (
      <span
        style={{
          fontSize: 11,
          color: 'var(--dim)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        — no trend yet —
      </span>
    );
  }

  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + h - (v / 100) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // Tier of the most recent point colours the polyline + the final dot.
  const last = values[values.length - 1]!;
  const tone = tierToTone(percentToTier(last));
  const colorVar =
    tone === 'ok'
      ? 'var(--ok)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'danger'
          ? 'var(--danger)'
          : 'var(--line-2)';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block' }}
      aria-label={`Score trend: ${values.join(', ')}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={colorVar}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {values.map((v, i) => {
        const x = pad + i * step;
        const y = pad + h - (v / 100) * h;
        const isLast = i === values.length - 1;
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={isLast ? 2.4 : 1.2}
            fill={colorVar}
            opacity={isLast ? 1 : 0.5}
          />
        );
      })}
    </svg>
  );
}
