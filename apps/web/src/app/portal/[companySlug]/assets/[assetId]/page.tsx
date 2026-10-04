import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getMeForMetadata,
  requireMe,
} from '../../../../../lib/server-api/auth';
import { getAsset } from '../../../../../lib/server-api/assets';
import { forMetadata } from '../../../../../lib/server-api/core';
import { resolvePortalCompany } from '../../../../../lib/portal-company';
import {
  PageBody,
  PageHeader,
} from '../../../../../components/shell/page-header';
import { LayoutSwatch, Tag } from '../../../../../components/ui';
import { AttachmentsPanel } from '../../../../../components/upload/attachments-panel';
import { CredentialsPanel } from '../../../../../components/passwords/credentials-panel';
import type { AssetFieldContext } from '../../../../../components/assets/asset-field-value';
import { AssetDetailView } from '../../../../../components/assets/asset-detail-view';
import { SidebarActive } from '../../../../../components/shell/sidebar-active';
import { recentRelative as relative } from '../../../../../lib/relative-time';

/**
 * Portal asset detail (read-only mirror of the admin page).
 *
 * The API already enforces `asset.read` at the membership boundary
 * and strips `visibleToClients=false` fields before the payload
 * leaves the service, so this page only has to render what it's
 * given. Differences vs. the admin detail page:
 *
 * - no `AssetActions` (clients can't edit/archive/delete),
 * - no `LinkedItemsPanel` (backend emits admin-scoped hrefs that
 *   would 404 for clients) and no Timing panel.
 * - read-only Attachments panel (download-only for clients).
 * - ASSET_REFERENCE chips link to the portal path
 *   (`/portal/<slug>/assets/<id>`), never the admin one.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ companySlug: string; assetId: string }>;
}): Promise<Metadata> {
  const { companySlug, assetId } = await params;
  const me = await getMeForMetadata();
  if (!me) return {};
  let company: { id: string; name: string; slug: string };
  try {
    company = await resolvePortalCompany(me, companySlug);
  } catch {
    return {};
  }
  const asset = await forMetadata(() => getAsset(company.id, assetId));
  return asset ? { title: asset.name } : {};
}

export default async function PortalAssetDetailPage({
  params,
}: {
  params: Promise<{ companySlug: string; assetId: string }>;
}) {
  const { companySlug, assetId } = await params;
  const me = await requireMe();
  const company = await resolvePortalCompany(me, companySlug);

  const asset = await getAsset(company.id, assetId);
  if (!asset) notFound();

  const portalBase = `/portal/${companySlug}`;

  const portalSlugByCompanyId = Object.fromEntries([
    ...me.memberships.map((m) => [m.company.id, m.company.slug]),
    [company.id, company.slug],
  ]);
  const fieldContext: AssetFieldContext = {
    assetHrefBase: `${portalBase}/assets`,
    richText: {
      isAdmin: false,
      portalSlugByCompanyId,
      fallbackCompanyId: asset.companyId,
    },
  };

  return (
    <>
      <SidebarActive id={`layout:${asset.assetLayoutId}`} />
      <PageHeader
        crumbs={[
          { label: company.name, href: portalBase },
          {
            label: asset.layoutName,
            href: `${portalBase}/layouts/${asset.layoutSlug}`,
            mono: true,
          },
          { label: asset.name },
        ]}
        leading={
          <LayoutSwatch
            icon={asset.layoutIcon}
            color={asset.layoutColor}
            size={48}
          />
        }
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {asset.name}
            {asset.archivedAt && <Tag tone="warn">archived</Tag>}
          </span>
        }
        description={`${asset.layoutName} · updated ${relative(new Date(asset.updatedAt))}`}
      />
      <PageBody>
        <div
          className="detail-grid-main-aside"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 300px',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <AssetDetailView asset={asset} context={fieldContext} />

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <CredentialsPanel
              companyId={company.id}
              assetId={asset.id}
              mode="portal"
              companySlug={companySlug}
            />
            <AttachmentsPanel
              companyId={company.id}
              entityType="asset"
              entityId={asset.id}
              editable={false}
            />
          </aside>
        </div>
      </PageBody>
    </>
  );
}
