import { ICON_PATHS } from '../../components/icon-paths';
import { layoutIconName } from './LayoutTile';

/**
 * `AssetLayout.icon` stores desktop icon-set keys; this pins the whole
 * layout-builder catalog (ICON_CHOICES in
 * apps/web/src/app/admin/(global)/layouts/layout-form-fields.tsx) to a
 * real glyph in the generated mobile set, so a catalog addition that
 * isn't mapped fails here instead of silently falling back.
 */
const DESKTOP_ICON_CATALOG = [
  'laptop',
  'server',
  'network',
  'box',
  'globe',
  'person',
  'building',
  'key',
  'doc',
  'shield',
  'folder',
  'tag',
  'clock',
  'image',
  'gear',
  'home',
] as const;

describe('layoutIconName', () => {
  it.each(DESKTOP_ICON_CATALOG)('maps catalog key %s to a shipped glyph', (key) => {
    const glyph = layoutIconName(key);
    expect(Object.keys(ICON_PATHS)).toContain(glyph);
  });

  it('distinguishes the keys (no two collapse to one glyph accidentally)', () => {
    const glyphs = DESKTOP_ICON_CATALOG.map(layoutIconName);
    expect(new Set(glyphs).size).toBe(DESKTOP_ICON_CATALOG.length);
  });

  it('unknown or legacy keys fall back to the box-equivalent glyph', () => {
    expect(layoutIconName('some_future_icon')).toBe('package_2');
    expect(layoutIconName('')).toBe('package_2');
  });
});
