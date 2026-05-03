import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getMe,
  listAssets,
  listLayouts,
} from '../../../../../lib/server-api';
import {
  PageBody,
  PageHeader,
} from '../../../../../components/shell/page-header';
import { LayoutSwatch, Panel, Tag } from '../../../../../components/ui';
import { LayoutAssetsTable } from '../../../../../components/layouts/layout-assets-table';

/**
 * Portal mirror of the admin per-layout asset list. The API already
 * enforces `asset.read` at the membership boundary and strips
 * fields with `visibleToClients=false` from the serialised output,
 * so this page just has to pick the right paths (portal-scoped) and
 * render the same table component the admin uses.
 */
async function loadContext(companySlug: string, layoutSlug: string) {
  const me = await getMe();
  const membership = me?.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) return null;
  const layouts = await listLayouts({ includeArchived: false });
  const layout = layouts.find((l) => l.slug === layoutSlug);
  if (!layout) return null;
  return { membership, layout };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ companySlug: string; layoutSlug: string }>;
}): Promise<Metadata> {
  const { companySlug, layoutSlug } = await params;
  const ctx = await loadContext(companySlug, layoutSlug);
  return ctx ? { title: ctx.layout.name } : {};
}

export default async function PortalLayoutAssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string; layoutSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companySlug, layoutSlug } = await params;
  const sp = await searchParams;

  const ctx = await loadContext(companySlug, layoutSlug);
  if (!ctx) notFound();
  const { membership, layout } = ctx;
  const companyId = membership.company.id;

  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const includeArchived = sp.archived === '1';

  const assets = await listAssets(companyId, {
    layoutId: layout.id,
    q,
    includeArchived,
    limit: 200,
  });

  return (
    <>
      <PageHeader
        crumbs={[
          { label: membership.company.name, href: `/portal/${companySlug}` },
          { label: layout.name },
        ]}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <LayoutSwatch icon={layout.icon} color={layout.color} size={28} />
            {layout.name}
          </span>
        }
        description={`Every ${layout.name} record shared with you for ${membership.company.name}.`}
      />
      <PageBody>
        <Panel
          title={
            <span>
              {assets.items.length} record{assets.items.length === 1 ? '' : 's'}
              {includeArchived && (
                <Tag tone="outline" style={{ marginLeft: 10 }}>
                  incl. archived
                </Tag>
              )}
            </span>
          }
          noPad
          fillHeight
        >
          <LayoutAssetsTable
            basePath={`/portal/${companySlug}`}
            layout={layout}
            rows={assets.items}
            q={q ?? ''}
            includeArchived={includeArchived}
            canManage={false}
          />
        </Panel>
      </PageBody>
    </>
  );
}
