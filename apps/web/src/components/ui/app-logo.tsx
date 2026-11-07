import type { CSSProperties } from 'react';

/**
 * Application logo. Renders the SVG asset(s) from `public/brand/`.
 *
 * Drop-in paths (each has a `-light` file for the light theme and a
 * `-dark` file for the dark theme):
 *   - `apps/web/public/brand/logo-wordmark-{light,dark}.svg` (horizontal lockup)
 *   - `apps/web/public/brand/logo-mark-{light,dark}.svg`     (square mark)
 *
 * Both variants of the chosen logo render, and CSS picks the right one
 * from `<html data-theme>` (set by `app/layout.tsx` at SSR). This avoids
 * a hydration flash and keeps the component a pure server component.
 * `size` is the rendered height in px.
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
  const style: CSSProperties =
    variant === 'mark'
      ? { width: size, height: size, flexShrink: 0 }
      : // `contain` keeps the aspect ratio when the width cap applies.
        {
          height: size,
          width: 'auto',
          maxWidth: size * 7,
          objectFit: 'contain',
          flexShrink: 0,
        };
  if (muted) style.opacity = 0.65;
  const file = variant === 'mark' ? 'logo-mark' : 'logo-wordmark';

  return (
    <>
      <img
        className="app-logo app-logo--light"
        src={`/brand/${file}-light.svg`}
        alt={title}
        style={style}
        draggable={false}
      />
      <img
        className="app-logo app-logo--dark"
        src={`/brand/${file}-dark.svg`}
        alt=""
        aria-hidden
        style={style}
        draggable={false}
      />
    </>
  );
}
