import type { CSSProperties } from 'react';

/**
 * Application logo. Renders the SVG asset(s) from `public/brand/`.
 *
 * Drop-in paths:
 *   - `apps/web/public/brand/logo-wordmark-light.svg` (used on light theme)
 *   - `apps/web/public/brand/logo-wordmark-dark.svg`  (used on dark theme)
 *   - `apps/web/public/brand/logo-mark.svg`           (square, 512×512)
 *
 * The wordmark renders both variants and lets CSS pick the right one
 * based on `<html data-theme>` (set by `app/layout.tsx` at SSR). This
 * avoids a hydration flash and keeps the component a pure server
 * component. `size` is the rendered height in px.
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
  if (variant === 'mark') {
    const style: CSSProperties = {
      width: size,
      height: size,
      display: 'inline-block',
      flexShrink: 0,
      color: muted ? 'var(--muted)' : 'var(--accent)',
    };
    return (
      <img
        src="/brand/logo-mark.svg"
        alt={title}
        style={style}
        draggable={false}
      />
    );
  }

  const wordmarkStyle: CSSProperties = {
    height: size,
    width: 'auto',
    maxWidth: size * 7,
    flexShrink: 0,
    opacity: muted ? 0.65 : 1,
  };

  return (
    <>
      <img
        className="app-logo-wordmark app-logo-wordmark--light"
        src="/brand/logo-wordmark-light.svg"
        alt={title}
        style={wordmarkStyle}
        draggable={false}
      />
      <img
        className="app-logo-wordmark app-logo-wordmark--dark"
        src="/brand/logo-wordmark-dark.svg"
        alt=""
        aria-hidden
        style={wordmarkStyle}
        draggable={false}
      />
    </>
  );
}
