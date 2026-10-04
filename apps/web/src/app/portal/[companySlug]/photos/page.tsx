import { requireMe } from '../../../../lib/server-api/auth';
import { listPhotos } from '../../../../lib/server-api/uploads';
import { resolvePortalCompany } from '../../../../lib/portal-company';
import { readPhotoQuery } from '../../../../lib/photo-query';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { LayoutSwatch, Panel } from '../../../../components/ui';
import { PhotoFilterBar } from '../../../../components/photos/photo-filter-bar';
import {
  PhotoEmptyState,
  PhotoGrid,
  PhotoLoadMore,
} from '../../../../components/photos/photo-gallery';
import { PortalPhotoTile } from './portal-photo-tile';

/**
 * Portal photos gallery — read-only view of the company's image
 * uploads. Filters mirror the admin page so a client admin can drill
 * into attachments for a specific asset or article. CLIENT_USER still
 * has `upload.read` so it remains accessible to all portal members.
 */
export default async function PortalPhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companySlug } = await params;
  const sp = await searchParams;
  const me = await requireMe();
  const company = await resolvePortalCompany(me, companySlug);
  const companyId = company.id;

  // No `includeNonLatest`: that admin audit toggle is not read here.
  const { attachedToType, attachedToId, cursor } = readPhotoQuery(sp);

  const page = await listPhotos(companyId, {
    attachedToType,
    attachedToId,
    limit: 48,
    cursor,
  });

  const basePath = `/portal/${companySlug}/photos`;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: company.name },
          { label: 'Photos' },
        ]}
        leading={<LayoutSwatch icon="image" color="var(--accent)" size={48} />}
        title="Photos"
        description="Images stored against this workspace's assets and articles."
      />
      <PageBody>
        <Panel noPad>
          <PhotoFilterBar
            basePath={basePath}
            attachedToType={attachedToType}
            attachedToId={attachedToId}
            count={page.items.length}
          />
          {page.items.length === 0 ? (
            <PhotoEmptyState
              message="No photos shared with your workspace yet."
              showIcon
            />
          ) : (
            <PhotoGrid>
              {page.items.map((photo) => (
                <PortalPhotoTile
                  key={photo.id}
                  photo={photo}
                  companySlug={companySlug}
                />
              ))}
            </PhotoGrid>
          )}
          <PhotoLoadMore
            basePath={basePath}
            nextCursor={page.nextCursor}
            attachedToType={attachedToType}
            attachedToId={attachedToId}
          />
        </Panel>
      </PageBody>
    </>
  );
}
