'use client';

import {
  Btn,
  Icon,
  LinkBtn,
  MenuDivider,
  MenuItem,
  OverflowMenu,
  StarGlyph,
  useStarToggle,
} from '../../../../../../components/ui';
import { useAssetArchive } from './asset-actions';

/**
 * The asset read view's whole action cluster, rendered into `TopBar`'s
 * `right` slot.
 *
 * This replaces the sub-row that used to carry up to five equal-weight
 * buttons (Star, Edit, Archive, Delete forever, New). What is left in
 * the row is the one action an operator came for — Edit, or Restore
 * when the asset is archived and Edit does not apply — plus the
 * overflow menu holding the rest.
 *
 * Star lives in the menu deliberately: the global cluster two icons to
 * the right already carries a star for *starred items*, and two stars
 * in one header is a coin toss.
 *
 * No attention dot: nothing this menu hides needs review. The asset's
 * one such signal — integration provenance — is a badge in the page
 * body and stays visible there.
 *
 * Copies `ArticleHeaderActions` in
 * `apps/web/src/app/admin/companies/[id]/articles/[articleId]/article-header-actions.tsx`.
 */
export function AssetHeaderActions({
  companyId,
  asset,
  manage,
}: {
  companyId: string;
  asset: {
    id: string;
    name: string;
    archivedAt: string | null;
    assetLayoutId: string;
    externalSource: string | null;
    isStarred: boolean;
  };
  /** Write access to this company, derived server-side. */
  manage: boolean;
}) {
  const { starred, toggle } = useStarToggle({
    entityType: 'asset',
    entityId: asset.id,
    initialStarred: asset.isStarred,
  });
  const { archived, requestArchiveToggle, requestPurge, dialogs } =
    useAssetArchive({
      asset: {
        id: asset.id,
        companyId,
        name: asset.name,
        archivedAt: asset.archivedAt,
        assetLayoutId: asset.assetLayoutId,
        externalSource: asset.externalSource,
      },
    });

  const base = `/admin/companies/${companyId}/assets`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {manage &&
        (archived ? (
          // Edit is unavailable while archived, so the primary slot
          // carries the action that makes it available again rather
          // than sitting empty.
          <Btn
            kind="solid"
            size="md"
            icon={Icon.check}
            onClick={requestArchiveToggle}
          >
            Restore
          </Btn>
        ) : (
          <LinkBtn
            href={`${base}/${asset.id}/edit`}
            kind="outline"
            size="md"
            icon={<Icon.edit size={13} />}
          >
            Edit
          </LinkBtn>
        ))}

      <OverflowMenu>
        {(close) => (
          <>
            <MenuItem
              glyph={<StarGlyph filled={starred} size={14} />}
              onClick={() => {
                void toggle();
              }}
            >
              {starred ? 'Starred' : 'Star'}
            </MenuItem>
            {manage && (
              <MenuItem
                icon={Icon.plus}
                href={`${base}/new?layout=${asset.assetLayoutId}`}
                onClick={close}
              >
                New asset
              </MenuItem>
            )}
            {manage && <MenuDivider />}
            {manage && !archived && (
              <MenuItem
                icon={Icon.archive}
                onClick={() => {
                  requestArchiveToggle();
                  close();
                }}
              >
                Archive
              </MenuItem>
            )}
            {manage && archived && (
              <MenuItem
                icon={Icon.trash}
                tone="danger"
                onClick={() => {
                  requestPurge();
                  close();
                }}
              >
                Delete forever
              </MenuItem>
            )}
          </>
        )}
      </OverflowMenu>

      {dialogs}
    </div>
  );
}
