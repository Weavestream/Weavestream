import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Photos' };
import { getMe } from '../../../../../lib/server-api/auth';
import { getSettings } from '../../../../../lib/server-api/settings';
import { getCompanyDetail } from '../../../../../lib/server-api/companies';
import { throwUnlessFound } from '../../../../../lib/server-api/core';
import { listPhotos } from '../../../../../lib/server-api/uploads';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { LayoutSwatch, Panel } from '../../../../../components/ui';
import { buildTerm } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { readBool, readPhotoQuery } from '../../../../../lib/photo-query';
import { PhotoFilterBar } from '../../../../../components/photos/photo-filter-bar';
import {
  PhotoEmptyState,
  PhotoGrid,
  PhotoLoadMore,
} from '../../../../../components/photos/photo-gallery';
import { AdminPhotoTile } from './admin-photo-tile';

/**
 * Phase 4 per-company photo gallery. `Upload` rows with `isImage=true`
 * light up here, filtered by optional `attachedToType`
 * (asset | article | asset_field) so operators can audit everything
 * uploaded against a single entity from one place.
 *
 * Admin-only on top of the shared gallery: the "Show orphaned &
 * archived" audit toggle and the operator tile (`AdminPhotoTile`).
 */
export default async function CompanyPhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;
  await getMe();
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const { attachedToType, attachedToId, cursor } = readPhotoQuery(sp);
  const includeNonLatest = readBool(sp.includeNonLatest);

  const page = await listPhotos(companyId, {
    attachedToType,
    attachedToId,
    limit: 60,
    cursor,
    includeNonLatest,
  });

  const basePath = `/admin/companies/${companyId}/photos`;

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Photos' })}
        leading={<LayoutSwatch icon="image" color="var(--accent)" size={48} />}
        title="Photos"
      // description={`Every image uploaded to this ${lower(
      //   term.one,
      // )} — attachments, article images, and asset-field captures.`}
      />
      <PageBody>
        <Panel noPad>
          <PhotoFilterBar
            basePath={basePath}
            attachedToType={attachedToType}
            attachedToId={attachedToId}
            count={page.items.length}
            nonLatest={{ included: includeNonLatest }}
          />
          {page.items.length === 0 ? (
            <PhotoEmptyState
              message="No photos yet for the current filter."
              hint="Attach an image to any asset or article and it will appear here."
            />
          ) : (
            <PhotoGrid>
              {page.items.map((photo) => (
                <AdminPhotoTile
                  key={photo.id}
                  photo={photo}
                  companyId={companyId}
                />
              ))}
            </PhotoGrid>
          )}
          <PhotoLoadMore
            basePath={basePath}
            nextCursor={page.nextCursor}
            attachedToType={attachedToType}
            attachedToId={attachedToId}
            includeNonLatest={includeNonLatest}
          />
        </Panel>
      </PageBody>
    </>
  );
}
