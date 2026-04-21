import type { CSSProperties, ReactElement } from 'react';
import { Icon, type IconComponent, type IconName, type IconProps } from './icon';

const FALLBACK_ICON: IconName = 'box';

/**
 * Compact layout marker used wherever an `AssetLayout.icon` key needs to
 * appear as a coloured chip: builder canvas, asset list rows, portal tiles.
 * Accepts a layout's stored `icon` string (matches `IconName`) and a
 * `color` CSS value. Falls back to the generic box icon when the stored
 * slug doesn't match the web icon set — this happens for legacy records
 * or preview rendering before the icon catalog was synced.
 */
export function LayoutSwatch({
  icon,
  color = 'var(--info)',
  size = 24,
  style,
}: {
  icon: string | IconComponent;
  color?: string;
  size?: number;
  style?: CSSProperties;
}): ReactElement {
  const IconCmp: IconComponent =
    typeof icon === 'function'
      ? icon
      : (Icon[(icon as IconName) in Icon ? (icon as IconName) : FALLBACK_ICON] as IconComponent);
  const iconSize: IconProps['size'] = Math.max(10, Math.round(size * 0.5));
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.17)),
        display: 'grid',
        placeItems: 'center',
        background: `color-mix(in oklch, ${color} 14%, transparent)`,
        color,
        border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
        flexShrink: 0,
        ...style,
      }}
    >
      <IconCmp size={iconSize} />
    </div>
  );
}
