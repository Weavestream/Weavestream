import { Icon } from '../../components/Icon';
import { ListRow } from '../../components/primitives';
import type { AssetRecord, LayoutRecord } from './api';
import { cardMetaParts } from './card-fields';
import { LayoutTile } from './LayoutTile';

/**
 * One asset card: layout tile · name · ONE meta line built from the
 * `isPrimary || showInTable` fields (build plan — never a third line).
 * The whole row is one button (`ListRow` with onClick); there is no
 * trailing action, so the PasswordRow nested-interactive escape hatch
 * isn't needed. Archived rows (reachable in a mixed cache moment, not
 * from the active-only list query) show the archive glyph.
 */
export function AssetRow({
  asset,
  layout,
  tz,
  onOpen,
}: {
  asset: AssetRecord;
  layout: LayoutRecord | undefined;
  tz: string;
  onOpen: () => void;
}) {
  const meta = cardMetaParts(asset, layout, tz).join(' · ');
  return (
    <ListRow
      title={asset.name}
      metaFont="sans"
      meta={meta !== '' ? meta : asset.layoutName}
      leading={<LayoutTile icon={asset.layoutIcon} color={asset.layoutColor} />}
      trailing={
        <span className="flex items-center gap-1.5">
          {asset.archivedAt !== null && (
            <Icon
              name="archive"
              size={18}
              className="shrink-0 text-warn"
              label="Archived"
            />
          )}
          <Icon name="chevron_right" size={22} className="shrink-0 text-faint" />
        </span>
      }
      onClick={onOpen}
    />
  );
}
