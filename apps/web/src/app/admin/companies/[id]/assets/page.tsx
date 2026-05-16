import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Assets' };
import {
  getActiveLayouts,
  getCompanyActivePasswords,
  getCompanyDetail,
  getMe,
  getSettings,
  listAssets,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Icon, LayoutSwatch, Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { AssetsTable } from './assets-table';

/**
 * Phase 3 — per-company asset list. Filters honour the `field.<slug>=`
 * DSL that the API enforces, layout filter, search, and archive
 * toggle — all driven by URL params so deep links / back button behave.
 */
export default async function CompanyAssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  const manage = canWriteCompany(me, company.id);

  const layoutId = typeof sp.layout === 'string' ? sp.layout : undefined;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const includeArchived = sp.archived === '1';
  const fieldFilters: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (!k.startsWith('field.')) continue;
    if (typeof v === 'string') fieldFilters[k.slice('field.'.length)] = v;
  }

  const [layouts, assets, passwords] = await Promise.all([
    getActiveLayouts(),
    listAssets(companyId, {
      layoutId,
      q,
      includeArchived,
      fieldFilters,
      limit: 200,
    }),
    // Passwords share the same global tag namespace as assets, so we load
    // them here too. The table surfaces matching credentials inline when
    // the operator picks a tag filter, since the per-company assets view
    // is the natural "find everything tagged X" landing page.
    getCompanyActivePasswords(companyId),
  ]);

  const activeLayout = layoutId
    ? layouts.find((l) => l.id === layoutId) ?? null
    : null;

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Assets' })}
        leading={<LayoutSwatch icon="box" color="var(--accent)" size={48} />}
        title="Assets"
        description={
          activeLayout
            ? `Filtered to ${activeLayout.name}.`
            : `Every asset tracked for this ${lower(term.one)}, across all layouts.`
        }
        actions={
          manage ? (
            <Link
              href={`/admin/companies/${companyId}/assets/new${layoutId ? `?layout=${layoutId}` : ''}`}
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
                letterSpacing: -0.1,
              }}
            >
              <Icon.plus size={13} />
              New asset
            </Link>
          ) : null
        }
      />
      <PageBody>
        <Panel
          title={
            <span>
              {assets.items.length} asset{assets.items.length === 1 ? '' : 's'}
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
          <AssetsTable
            companyId={companyId}
            rows={assets.items}
            passwords={passwords}
            layouts={layouts}
            q={q ?? ''}
            layoutId={layoutId ?? ''}
            includeArchived={includeArchived}
            fieldFilters={fieldFilters}
            canManage={manage}
          />
        </Panel>
      </PageBody>
    </>
  );
}
