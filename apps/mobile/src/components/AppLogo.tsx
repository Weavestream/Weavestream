import wordmarkLight from '../assets/logo-wordmark-light.svg?no-inline';
import wordmarkDark from '../assets/logo-wordmark-dark.svg?no-inline';

/**
 * The Weavestream lockup — the "W" mark plus the wordmark, as one SVG.
 *
 * Imported through Vite rather than referenced as `/brand/...`. Three
 * reasons, all of which bite silently otherwise:
 *
 *  - Vite records it in the build manifest, so `emit-to-web.mjs` keeps it
 *    and `check-mobile-bundle.mjs` guards it. A bare `/brand/` path is
 *    invisible to both, and a missing asset would surface as a broken
 *    image with nothing failing in CI.
 *  - It survives the future Capacitor packaging step, where there is no
 *    `apps/web/public` to reach into.
 *  - It must never be inlined as a `data:` URI — `img-src 'self'` blocks
 *    that, with no symptom beyond a console violation. These files are
 *    ~2 KB, below `build.assetsInlineLimit` (4096 B), so the imports
 *    carry `?no-inline` to force a real file. Keep that flag on any
 *    small image added later.
 *
 * Both variants render and CSS picks one (`.m-logo--*` in globals.css,
 * including the system-pref media block), so the stamped shell shows the
 * correct wordmark before any JS runs — same trick as desktop's AppLogo.
 * Sized by height with `width: auto` — the artwork is not square
 * (desktop's `variant="mark"` sets both dimensions and squashes it).
 */
export function AppLogo({ height = 28 }: { height?: number }) {
  const style = { height, width: 'auto' } as const;
  return (
    <>
      <img
        className="m-logo--light"
        src={wordmarkLight}
        alt="Weavestream"
        draggable={false}
        style={style}
      />
      {/* Both carry the alt: `display: none` drops the hidden variant
          from the accessibility tree, so exactly one name is ever
          exposed — aria-hiding the dark one would leave dark mode with
          no accessible name at all. */}
      <img
        className="m-logo--dark"
        src={wordmarkDark}
        alt="Weavestream"
        draggable={false}
        style={style}
      />
    </>
  );
}
