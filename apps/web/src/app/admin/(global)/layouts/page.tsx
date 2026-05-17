import Link from 'next/link';
import { getMe, getSettings, listLayouts } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Icon, Panel, Tag } from '../../../../components/ui';
import { buildTerm, lower } from '../../../../lib/term';
import { CreateLayoutButton } from './create-layout-button';
import { LayoutsList } from './layouts-list';

/**
 * Phase 3 — Global asset layout catalog. Per DECISIONS.md D-007 layouts
 * are global (no per-company catalog), so this page is the single entry
 * point for the entire product. SUPER_ADMIN sees a `New layout` CTA
 * + archive/restore actions on every row; every other operator sees a
 * read-only roster so they know what layouts exist when they later pick
 * a layout on `/admin/companies/[id]/assets/new`.
 *
 * As of the company-switcher work this page also drives the order in
 * which layouts appear inside the company-scoped sidebar. SUPER_ADMINs
 * can reorder rows with up/down controls; the positions are persisted
 * via `PATCH /layouts/reorder` and propagate to every company sidebar.
 */
export default async function LayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ includeArchived?: string }>;
}) {
  const sp = await searchParams;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());
  // RBAC v2 — layouts are global; mutation is gated on `LAYOUT_MANAGE`.
  // SUPER_ADMIN holds it implicitly, OPERATORs can be granted it.
  const canEdit = hasCapability(me, 'LAYOUT_MANAGE');
  const includeArchived = sp.includeArchived === '1';
  const layouts = await listLayouts({ includeArchived });

  const activeCount = layouts.filter((l) => !l.archivedAt).length;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Layouts' },
        ]}
        title="Layouts"
        description={`Define and structure global asset templates across all ${lower(
          term.other,
        )}. Rearrange the list to change how they appear in the navigation sidebar.`}
        actions={canEdit ? <CreateLayoutButton /> : null}
      />
      <PageBody>
        <Panel
          title={
            <span>
              {activeCount} active
              {includeArchived && layouts.length !== activeCount && (
                <Tag tone="outline" style={{ marginLeft: 10 }}>
                  +{layouts.length - activeCount} archived
                </Tag>
              )}
            </span>
          }
          actions={
            <Link
              href={
                includeArchived ? '/admin/layouts' : '/admin/layouts?includeArchived=1'
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 26,
                padding: '0 9px',
                fontSize: 12,
                fontWeight: 500,
                border: '1px solid var(--line-2)',
                borderRadius: 5,
                color: 'var(--text-2)',
                background: includeArchived ? 'var(--panel-2)' : 'transparent',
              }}
            >
              <Icon.archive size={12} />
              {includeArchived ? 'Hide archived' : 'Show archived'}
            </Link>
          }
          noPad
        >
          <LayoutsList layouts={layouts} canEdit={canEdit} />
        </Panel>
      </PageBody>
    </>
  );
}
