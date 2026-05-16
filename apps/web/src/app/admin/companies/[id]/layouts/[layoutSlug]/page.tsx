import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getActiveLayouts,
  getCompanyDetail,
  getMe,
  getSettings,
  listAssets,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../../lib/roles';
import {
  PageBody,
  PageHeader,
} from '../../../../../../components/shell/page-header';
import { Icon, LayoutSwatch, Panel, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { LayoutAssetsTable } from '../../../../../../components/layouts/layout-assets-table';

/**
 * Per-layout asset list for a single company. This is the page that
 * every layout entry in the company sidebar navigates to. Compared
 * to the flat `/assets` list, the columns here come straight from
 * the layout definition (`showInTable=true` fields, primary always
 * first), which gives operators a real "Workstations" / "LAN
 * devices" / "Software licenses" view instead of a generic list.
 *
 * The layout is addressed by slug (not UUID) so deep links are
 * human-readable. We resolve it server-side against the active,
 * non-archived layouts list.
 */
async function loadContext(companyId: string, layoutSlug: string) {
  const [companyRes, layouts] = await Promise.all([
    getCompanyDetail(companyId),
    getActiveLayouts(),
  ]);
  if (!companyRes.ok || !companyRes.data) return null;
  const layout = layouts.find((l) => l.slug === layoutSlug);
  if (!layout) return null;
  return { company: companyRes.data, layout };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; layoutSlug: string }>;
}): Promise<Metadata> {
  const { id, layoutSlug } = await params;
  const ctx = await loadContext(id, layoutSlug);
  if (!ctx) return {};
  // Parent layout's `template: "%s · <company>"` fills in the rest.
  return { title: ctx.layout.name };
}

export default async function LayoutAssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; layoutSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId, layoutSlug } = await params;
  const sp = await searchParams;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());

  // For the page render we intentionally bypass `loadContext` so 429/
  // network failures surface through `throwUnlessFound` instead of
  // being swallowed as "not found". `generateMetadata` keeps the loose
  // null-return path since it must never itself throw a rendering
  // error — it just falls back to an empty title object.
  const [companyRes, layouts] = await Promise.all([
    getCompanyDetail(companyId),
    getActiveLayouts(),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  const layout = layouts.find((l) => l.slug === layoutSlug);
  if (!layout) notFound();
  const manage = canWriteCompany(me, company.id);

  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const includeArchived = sp.archived === '1';

  // Filter server-side by layoutId so counts + row data stay
  // consistent with the sidebar.
  const assets = await listAssets(companyId, {
    layoutId: layout.id,
    q,
    includeArchived,
    limit: 200,
  });

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: layout.name })}
        leading={
          <LayoutSwatch icon={layout.icon} color={layout.color} size={48} />
        }
        title={layout.name}
        description={`Every ${layout.name} record tracked for ${company.name}.`}
        actions={
          manage ? (
            <Link
              href={`/admin/companies/${companyId}/assets/new?layout=${layout.id}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                padding: '0 11px',
                background: 'var(--accent)',
                color: 'var(--accent-ink)',
                borderRadius: 5,
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              <Icon.plus size={13} />
              New {layout.name}
            </Link>
          ) : null
        }
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
            basePath={`/admin/companies/${companyId}`}
            layout={layout}
            rows={assets.items}
            q={q ?? ''}
            includeArchived={includeArchived}
            canManage={manage}
          />
        </Panel>
      </PageBody>
    </>
  );
}
