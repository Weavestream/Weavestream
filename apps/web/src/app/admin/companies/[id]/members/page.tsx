import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Members' };
import {
  getCompanyDetail,
  getCompanyMemberships,
  requireMe,
  getSettings,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { hasCapability } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { ErrorBanner, LayoutSwatch, Panel } from '../../../../../components/ui';
import { buildTerm } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { MembersTable } from './members-table';

/**
 * Who has access to this company. Split out of company home, which is a
 * glance overview and had grown a full management surface inside one
 * panel.
 *
 * Deliberately not redirect-gated. `GET /companies/:id/memberships`
 * needs only `membership.read` — anyone who can see the company may see
 * who else can. The write controls carry their own gates below, and the
 * API stays the authorization source of truth either way.
 */
export default async function CompanyMembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: companyId } = await params;
  const me = await requireMe();
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const membershipsRes = await getCompanyMemberships(companyId);
  const rows = membershipsRes.data ?? [];
  const membershipsError = !membershipsRes.ok ? membershipsRes : null;

  // Membership writes are platform-admin, not a per-company write, so
  // `canWriteCompany` is the wrong gate here. Inviting and attaching a
  // user additionally touches `/users`, which is a separate capability.
  const canManage = hasCapability(me, 'MEMBERSHIP_MANAGE');
  const canInvite = canManage && hasCapability(me, 'USER_MANAGE');

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Members' })}
        leading={<LayoutSwatch icon="users" color="var(--accent)" size={48} />}
        title="Members"
      />
      <PageBody>
        {membershipsError ? (
          <ErrorBanner
            title="Couldn't load memberships."
            detail={
              (membershipsError.problem as { detail?: string } | undefined)?.detail ??
              `The memberships endpoint returned HTTP ${membershipsError.status}.`
            }
          />
        ) : null}
        <Panel
          title={
            <span>
              {rows.length} member{rows.length === 1 ? '' : 's'}
            </span>
          }
          noPad
          fillHeight
        >
          <MembersTable
            companyId={company.id}
            companyName={company.name}
            companySlug={company.slug}
            companyArchivedAt={company.archivedAt}
            initial={rows}
            canManage={canManage}
            canInvite={canInvite}
          />
        </Panel>
      </PageBody>
    </>
  );
}
