'use client';

import { useState, type CSSProperties } from 'react';
import { WeavestreamLogo } from './weavestream-logo';

/**
 * Phase 9b.1 — application logo. Renders the SVG asset from
 * `public/brand/` when it loads; otherwise falls back to an inline
 * typographic treatment. This keeps the first deploy safe (no
 * broken-image icon anywhere) and gives partners a single SVG to drop
 * in — no build step, no code change.
 *
 * Drop-in paths:
 *   - `apps/web/public/brand/logo-wordmark.svg`  (horizontal text)
 *   - `apps/web/public/brand/logo-mark.svg`      (square, 512×512)
 *
 * `size` is the rendered height in px to mirror `WeavestreamLogo`, so
 * migrating call sites is a one-liner.
 */
export function AppLogo({
  variant = 'wordmark',
  size = 18,
  muted = false,
  title = 'Weavestream',
}: {
  variant?: 'wordmark' | 'mark';
  size?: number;
  muted?: boolean;
  title?: string;
}) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    if (variant === 'mark') return <FallbackMark size={size} />;
    return <WeavestreamLogo size={size} muted={muted} />;
  }

  const style: CSSProperties =
    variant === 'mark'
      ? {
          width: size,
          height: size,
          display: 'inline-block',
          flexShrink: 0,
          // Mark uses currentColor — inherit the surrounding accent so
          // sidebars that wrap it in color inherit the tint without a
          // CSS filter.
          color: muted ? 'var(--muted)' : 'var(--accent)',
        }
      : {
          height: size,
          width: 'auto',
          // Cap width so an accidentally-tall replacement SVG doesn't
          // blow the sidebar out horizontally.
          maxWidth: size * 7,
          color: muted ? 'var(--muted)' : 'var(--text)',
          display: 'inline-block',
          flexShrink: 0,
        };

  const src =
    variant === 'mark' ? '/brand/logo-mark.svg' : '/brand/logo-wordmark.svg';

  return (
    <img
      src={src}
      alt={title}
      style={style}
      onError={() => setErrored(true)}
      draggable={false}
    />
  );
}

/** Minimal visual fallback for the square mark — matches the inline
 * sidebar block the shell used before AppLogo existed. */
function FallbackMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.23)),
        background: 'var(--accent)',
        color: 'var(--accent-ink)',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-display)',
        fontWeight: 800,
        fontStyle: 'italic',
        fontSize: Math.max(10, Math.round(size * 0.6)),
        flexShrink: 0,
      }}
    >
      W
    </span>
  );
}
