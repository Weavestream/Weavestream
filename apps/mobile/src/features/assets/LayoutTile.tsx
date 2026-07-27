import { Icon, type IconName } from '../../components/Icon';

/**
 * Layout identity tile — the layout's actual icon on a tint derived
 * from its customer-chosen color (desktop LayoutSwatch parity; initials
 * were a v1 placeholder Andy replaced).
 *
 * `AssetLayout.icon` stores the DESKTOP icon-set key (the layout
 * builder's ICON_CHOICES). Mobile ships Material Symbols glyphs, so
 * the keys are mapped here; the schema allows any snake_case string,
 * and desktop falls back to its generic `box` for unknown keys — the
 * mapped `package_2` is the same fallback in this set.
 *
 * The inline style is data-driven color (the layout's own `color`
 * column), not an authored constant, so the no-literal-hex rule doesn't
 * apply; `color-mix` keeps contrast sane against light surfaces
 * regardless of how saturated the stored color is.
 */

const FALLBACK_GLYPH: IconName = 'package_2';

const LAYOUT_ICON_MAP: Record<string, IconName> = {
  laptop: 'laptop_mac',
  server: 'dns',
  network: 'lan',
  box: 'package_2',
  globe: 'language',
  person: 'person',
  building: 'apartment',
  key: 'key',
  doc: 'description',
  shield: 'shield',
  folder: 'folder',
  tag: 'sell',
  clock: 'schedule',
  image: 'image',
  gear: 'settings',
  home: 'home',
};

/** Desktop icon key → mobile glyph, `box`-equivalent fallback. */
export function layoutIconName(icon: string): IconName {
  return LAYOUT_ICON_MAP[icon] ?? FALLBACK_GLYPH;
}

export function LayoutTile({
  icon,
  color,
  size = 40,
}: {
  /** The layout's stored icon key (desktop icon-set name). */
  icon: string;
  color: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-tile"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
      }}
    >
      <Icon name={layoutIconName(icon)} size={Math.max(14, Math.round(size * 0.55))} />
    </span>
  );
}
