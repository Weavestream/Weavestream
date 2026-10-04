import { Icon, Tag } from '../../../../../components/ui';
import {
  PhotoActionChip,
  PhotoTile,
} from '../../../../../components/photos/photo-tile';
import { attachmentLabel, buildPhotosHref } from '../../../../../lib/photo-query';
import type { UploadSummary } from '../../../../../lib/server-api/uploads';
import { PhotoDeleteChip } from './photo-delete-chip';

/**
 * Admin gallery tile: the shared `PhotoTile` plus the operator-only
 * parts — a link-state badge for article images, Open / Related links
 * to the source entity, and Delete for orphan or archived images.
 */
export function AdminPhotoTile({
  photo,
  companyId,
}: {
  photo: UploadSummary;
  companyId: string;
}) {
  const stateBadge = stateBadgeFor(photo);
  const deletable =
    photo.articleLinkState === 'orphan' ||
    photo.articleLinkState === 'archived';
  const linkInfo = resolveSourceLink(companyId, photo);

  return (
    <PhotoTile
      photo={photo}
      badges={
        stateBadge && <Tag tone={stateBadge.tone}>{stateBadge.label}</Tag>
      }
      actions={
        linkInfo || deletable ? (
          <>
            {linkInfo && (
              <PhotoActionChip
                href={linkInfo.sourceHref}
                icon={<Icon.ext size={10} />}
                label="Open"
                tone="accent"
                title={
                  linkInfo.sourceTitle
                    ? `Open ${linkInfo.label}: ${linkInfo.sourceTitle}`
                    : `Open source ${linkInfo.label}`
                }
              />
            )}
            {linkInfo?.filterHref && (
              <PhotoActionChip
                href={linkInfo.filterHref}
                icon={<Icon.grid size={10} />}
                label="Related"
                tone="muted"
                title={`View all photos for this ${linkInfo.label}`}
              />
            )}
            {deletable && (
              <PhotoDeleteChip
                photo={photo}
                state={photo.articleLinkState as 'orphan' | 'archived'}
              />
            )}
          </>
        ) : null
      }
    />
  );
}

/**
 * Visual badge that summarises an article-attached image's link state
 * for the photos grid. `live` images don't get a badge (they're the
 * default state); the other states all warrant a tag so operators can
 * see at a glance why a photo lacks an Open chip or carries a Delete
 * affordance. `null` for non-article uploads and any unknown state.
 */
function stateBadgeFor(
  photo: UploadSummary,
): { tone: 'warn' | 'danger'; label: string } | null {
  switch (photo.articleLinkState) {
    case 'archived':
      return { tone: 'warn', label: 'Archived' };
    case 'versioned':
      return { tone: 'warn', label: 'Old version' };
    case 'orphan':
      return { tone: 'danger', label: 'Orphan' };
    default:
      return null;
  }
}

/**
 * Pick the best "open source X" / "view all for this X" link for a
 * photo tile. Asset and asset_field uploads ship with an
 * `attachedToId` and can deep-link directly. Article uploads never
 * carry an id — the owning article is resolved server-side via
 * `sourceArticle` (a body-scan of active + archived articles and
 * non-draft version snapshots), so we use that here instead.
 *
 * For article images: `live` and `archived` get an Open link to the
 * owning article (the archived detail page still loads and shows the
 * banner). `versioned` skips Open because the history-restore UI
 * lives inside the article detail page and there's no stable URL to
 * a specific version preview. `orphan` has no destination by
 * definition.
 */
function resolveSourceLink(
  companyId: string,
  photo: UploadSummary,
): {
  label: string;
  sourceHref: string;
  filterHref: string | null;
  sourceTitle: string | null;
} | null {
  if (!photo.attachedToType) return null;
  const label = attachmentLabel(photo.attachedToType).toLowerCase();
  if (photo.attachedToType === 'article') {
    if (!photo.sourceArticle) return null;
    if (
      photo.articleLinkState !== 'live' &&
      photo.articleLinkState !== 'archived'
    ) {
      return null;
    }
    return {
      label:
        photo.articleLinkState === 'archived' ? 'archived article' : label,
      sourceHref: `/admin/companies/${companyId}/articles/${encodeURIComponent(
        photo.sourceArticle.id,
      )}`,
      filterHref: null,
      sourceTitle: photo.sourceArticle.title,
    };
  }
  if (!photo.attachedToId) return null;
  const href = sourceHref(companyId, photo.attachedToType, photo.attachedToId);
  if (!href) return null;
  return {
    label,
    sourceHref: href,
    filterHref: buildPhotosHref(`/admin/companies/${companyId}/photos`, {
      attachedToType: photo.attachedToType,
      attachedToId: photo.attachedToId,
    }),
    sourceTitle: null,
  };
}

/**
 * Map an `(attachedToType, attachedToId)` pair back to the page that
 * represents the source entity. `asset_field` uploads (photos captured
 * inline on an asset's FILE field) point back at the parent asset —
 * the attachedToId IS the asset id. Returns null for attachment types
 * that don't yet have a dedicated detail page.
 */
function sourceHref(
  companyId: string,
  attachedToType: string,
  attachedToId: string,
): string | null {
  switch (attachedToType) {
    case 'asset':
    case 'asset_field':
      return `/admin/companies/${companyId}/assets/${encodeURIComponent(attachedToId)}`;
    case 'article':
      return `/admin/companies/${companyId}/articles/${encodeURIComponent(attachedToId)}`;
    default:
      return null;
  }
}
