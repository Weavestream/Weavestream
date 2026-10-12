import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import React from 'react';
import { requireMe } from '../../../../../../lib/server-api/auth';
import { getSettings } from '../../../../../../lib/server-api/settings';
import { getCompanyDetail } from '../../../../../../lib/server-api/companies';
import { getAsset } from '../../../../../../lib/server-api/assets';
import {
  forMetadata,
  throwUnlessFound,
} from '../../../../../../lib/server-api/core';
import { canWriteCompany } from '../../../../../../lib/roles';
import {
  DetailTitle,
  PageBody,
} from '../../../../../../components/shell/page-header';
import { TopBar } from '../../../../../../components/shell/top-bar';
import { Icon, LayoutSwatch, Panel, ShowMore, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { LinkedItemsPanel } from '../../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../../components/upload/attachments-panel';
import { CredentialsPanel } from '../../../../../../components/passwords/credentials-panel';
import type { AssetFieldContext } from '../../../../../../components/assets/asset-field-value';
import { AssetDetailView } from '../../../../../../components/assets/asset-detail-view';
import { AssetChatContext } from '../../../../../../components/chat-panel/asset-chat-context';
import { SidebarActive } from '../../../../../../components/shell/sidebar-active';
import { AssetHeaderActions } from './asset-header-actions';
import {
  ProvenanceBadge,
  provenanceAttention,
} from '../../../../../../components/integrations/provenance-badge';
import { recentRelative as relative } from '../../../../../../lib/relative-time';
import { IntegrationSections } from '../../../../../../components/integrations/integration-sections';
import { assetSourcesLabel } from '../../../../../../lib/asset-sources';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}): Promise<Metadata> {
  const { id, assetId } = await params;
  const asset = await forMetadata(() => getAsset(id, assetId));
  return asset ? { title: asset.name } : {};
}

/**
 * Asset detail. Mirrors the design template: header chip strip + layout
 * swatch, two-column key/value grid of stored field values, freeform
 * notes block (if the layout carries a RICH_TEXT/TEXTAREA field), and a
 * right rail with the Linked items panel backed by the Relation table.
 */
export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const { id: companyId, assetId } = await params;
  const me = await requireMe();
  const term = buildTerm(await getSettings());
  const [companyRes, asset] = await Promise.all([
    getCompanyDetail(companyId),
    getAsset(companyId, assetId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  if (!asset) notFound();
  const manage = canWriteCompany(me, company.id);

  const createdBy = asset.createdByUser;
  const updatedBy = asset.updatedByUser;

  const fieldContext: AssetFieldContext = {
    assetHrefBase: `/admin/companies/${companyId}/assets`,
    richText: { isAdmin: true, fallbackCompanyId: companyId },
  };

  return (
    <>
      <AssetChatContext asset={asset} />
      <SidebarActive id={`layout:${asset.assetLayoutId}`} />
      <TopBar
        crumbs={companyCrumbs(
          term,
          company,
          {
            label: asset.layoutName,
            href: `/admin/companies/${companyId}/layouts/${asset.layoutSlug}`,
            mono: true,
          },
          { label: asset.name },
        )}
        // One row, not two. The asset's own actions ride in the
        // breadcrumb row beside the global cluster, and the identity
        // block that used to share the old sub-row now heads the body.
        right={
          <AssetHeaderActions
            companyId={companyId}
            asset={{
              id: asset.id,
              name: asset.name,
              archivedAt: asset.archivedAt,
              assetLayoutId: asset.assetLayoutId,
              externalSource: assetSourcesLabel(asset),
              isStarred: asset.isStarred,
            }}
            manage={manage}
          />
        }
      />
      <PageBody>
        <DetailTitle
          leading={
            <LayoutSwatch
              icon={asset.layoutIcon}
              color={asset.layoutColor}
              size={48}
            />
          }
          name={asset.name}
          tags={asset.archivedAt ? <Tag tone="warn">archived</Tag> : null}
        />
        <div
          className="detail-grid-main-aside"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 320px',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <AssetDetailView asset={asset} context={fieldContext} />
            <IntegrationSections
              sections={asset.integrationSections ?? []}
              companyId={companyId}
              assetId={asset.id}
              canResolve={manage && !asset.archivedAt}
            />
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <LinkedItemsPanel
              companyId={companyId}
              entityType="asset"
              entityId={asset.id}
              editable={manage && !asset.archivedAt}
            />

            <CredentialsPanel
              companyId={companyId}
              assetId={asset.id}
              mode="admin"
            />

            <AttachmentsPanel
              companyId={companyId}
              entityType="asset"
              entityId={asset.id}
              editable={manage && !asset.archivedAt}
            />

            <ShowMore attention={provenanceAttention(asset.provenance)}>
              <Panel title="Last activity">
                {(() => {
                  const rows: React.ReactNode[] = [];
                  rows.push(
                    <Row
                      key="created"
                      label="Created"
                      value={new Date(asset.createdAt).toLocaleString()}
                    />,
                  );
                  if (createdBy) {
                    rows.push(
                      <Row
                        key="created-by"
                        label="Created by"
                        value={createdBy.name}
                      />,
                    );
                  }
                  rows.push(
                    <Row
                      key="updated"
                      label="Updated"
                      value={new Date(asset.updatedAt).toLocaleString()}
                    />,
                  );
                  if (updatedBy) {
                    rows.push(
                      <Row
                        key="updated-by"
                        label="Updated by"
                        value={updatedBy.name}
                      />,
                    );
                  }
                  // One row per integration; an asset can carry several sync
                  // records for the same integration (e.g. one per Breeze
                  // custom-field value), which would render as duplicate rows.
                  const syncByIntegration = new Map<
                    string,
                    {
                      driver: string;
                      integrationName: string;
                      lastSyncedAt: string;
                      resourceKeys: Set<string>;
                    }
                  >();
                  for (const src of asset.syncSources) {
                    const entry = syncByIntegration.get(src.integrationId);
                    if (!entry) {
                      syncByIntegration.set(src.integrationId, {
                        driver: src.driver,
                        integrationName: src.integrationName,
                        lastSyncedAt: src.lastSyncedAt,
                        resourceKeys: new Set([src.resourceKey]),
                      });
                    } else {
                      entry.resourceKeys.add(src.resourceKey);
                      if (
                        Date.parse(src.lastSyncedAt) >
                        Date.parse(entry.lastSyncedAt)
                      ) {
                        entry.lastSyncedAt = src.lastSyncedAt;
                      }
                    }
                  }
                  for (const [integrationId, src] of syncByIntegration) {
                    rows.push(
                      <Row
                        key={`sync-${integrationId}`}
                        label={`Synced · ${src.driver.toLowerCase()}`}
                        value={relative(new Date(src.lastSyncedAt))}
                        title={`${src.integrationName} · ${[...src.resourceKeys].join(', ')} · last synced ${new Date(src.lastSyncedAt).toLocaleString()}`}
                      />,
                    );
                  }
                  if (asset.archivedAt) {
                    rows.push(
                      <Row
                        key="archived"
                        label="Archived"
                        value={new Date(asset.archivedAt).toLocaleString()}
                      />,
                    );
                  }
                  // Strip the bottom border from the final row.
                  return rows.map((node, i) =>
                    i === rows.length - 1 && React.isValidElement(node)
                      ? React.cloneElement(
                          node as React.ReactElement<RowProps>,
                          { last: true },
                        )
                      : node,
                  );
                })()}
              </Panel>

              {asset.provenance.map((provenance) => (
                <ProvenanceBadge
                  key={`${provenance.integrationId}:${provenance.resourceId}`}
                  provenance={provenance}
                />
              ))}
            </ShowMore>

            <Link
              href={`/admin/companies/${companyId}/layouts/${asset.layoutSlug}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <Icon.chevron size={10} style={{ transform: 'rotate(180deg)' }} />
              back to list
            </Link>
          </aside>
        </div>
      </PageBody>
    </>
  );
}

interface RowProps {
  label: string;
  value: string;
  last?: boolean;
  title?: string;
}

function Row({ label, value, last, title }: RowProps) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        gap: 8,
        padding: '6px 0',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        fontSize: 12,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontSize: 10.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: 'var(--text-2)',
          textAlign: 'right',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}
