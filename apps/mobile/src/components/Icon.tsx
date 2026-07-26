import { ICON_PATHS, ICON_VIEWBOX, type IconName } from './icon-paths';

export type { IconName };

/**
 * Material Symbols Rounded as inline SVG.
 *
 * Inline rather than a webfont: the paths are generated at build time by
 * `scripts/gen-icons.mjs`, so nothing icon-related reaches the runtime
 * bundle beyond the ~29 `d` strings we actually use. See that script for
 * the full reasoning (CSP, subsetting toolchain, FOIT on a bad radio).
 *
 * `fill="currentColor"` so colour comes from the token on the parent —
 * never write a hex here. `size` is both dimensions in px; the handoff's
 * sizes are 18/20/21/22/25/29 depending on context.
 *
 * Decorative by default (`aria-hidden`). An icon that is the *only*
 * content of a control must not rely on this component for its name —
 * put `aria-label` on the button. `label` exists for the rarer case of
 * an icon carrying meaning next to text that doesn't repeat it (e.g. a
 * status glyph in a row).
 */
export function Icon({
  name,
  size = 24,
  className,
  label,
}: {
  name: IconName;
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      // Stops the glyph from being squeezed by a flex parent, which is
      // most of where these live (rows, chips, buttons).
      style={{ flex: '0 0 auto' }}
      {...(label
        ? { role: 'img', 'aria-label': label }
        : { 'aria-hidden': true, focusable: false })}
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
