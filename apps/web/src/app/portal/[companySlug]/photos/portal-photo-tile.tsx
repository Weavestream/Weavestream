import { Icon } from '../../../../components/ui';
import {
  PhotoActionChip,
  PhotoTile,
} from '../../../../components/photos/photo-tile';
import type { UploadSummary } from '../../../../lib/server-api/uploads';

/**
 * Portal gallery tile: the shared `PhotoTile` with one action — Open
 * for an article image, linked by slug to the portal article page.
 * Clients get no link-state badges, no Related filter, and no Delete.
 */
export function PortalPhotoTile({
  photo,
  companySlug,
}: {
  photo: UploadSummary;
  companySlug: string;
}) {
  const article =
    photo.attachedToType === 'article' ? photo.sourceArticle : null;
  return (
    <PhotoTile
      photo={photo}
      actions={
        article && (
          <PhotoActionChip
            href={`/portal/${companySlug}/articles/${encodeURIComponent(
              article.slug,
            )}`}
            icon={<Icon.ext size={10} />}
            label="Open"
            title={`Open article: ${article.title}`}
          />
        )
      }
    />
  );
}
