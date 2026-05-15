import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Tickets' };

import { notFound } from 'next/navigation';
import {
  getCompanyDetail,
  getCompanyTicketingCapability,
  getMe,
  getSettings,
  listCompanyTickets,
  throwUnlessFound,
  type TicketListFilters,
} from '../../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { TicketsBrowser } from './tickets-browser';

/**
 * Phase 12 — read-only ticket browse, real-time from the company's
 * mapped ticketing integration (NinjaOne today). Filters and cursor
 * pagination are URL-driven so deep links / refresh survive cleanly.
 *
 * Admin-only by composition: the layout's sidebar already hides the
 * entry for portal users, AND the API enforces `article.write` on
 * every fetch — clients who reach the URL directly get a 403.
 */
export default async function CompanyTicketsPage({
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

  const [companyRes, hasTicketing] = await Promise.all([
    getCompanyDetail(companyId),
    getCompanyTicketingCapability(companyId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  // If the company has no ticketing-capable mapping the page would
  // surface "no records" with no clear cause. Showing a 404 instead
  // is consistent with the sidebar (which doesn't expose the link in
  // the first place) and avoids implying the operator merely needs to
  // change filters.
  if (!hasTicketing) notFound();

  const filter = parseFilter(sp);
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : null;
  const page = await listCompanyTickets(companyId, {
    ...filter,
    ...(cursor ? { cursor } : {}),
  });

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Tickets' })}
        title="Tickets"
        description={`Browse live tickets from the connected ticketing system for this ${lower(
          term.one,
        )}, and hand off to the AI to draft a knowledge-base article.`}
      />
      <PageBody>
        <Panel
          title={
            <span>
              {page.records.length} ticket
              {page.records.length === 1 ? '' : 's'}
              {page.cursor ? ' on this page' : ''}
            </span>
          }
          noPad
          fillHeight
        >
          <TicketsBrowser
            companyId={companyId}
            rows={page.records}
            cursor={page.cursor}
            filter={filter}
            activeCursor={cursor}
            actorId={me.id}
          />
        </Panel>
      </PageBody>
    </>
  );
}

function parseFilter(
  sp: Record<string, string | string[] | undefined>,
): TicketListFilters {
  const out: TicketListFilters = {};
  const status = typeof sp.status === 'string' ? sp.status : undefined;
  if (
    status === 'open' ||
    status === 'pending' ||
    status === 'resolved' ||
    status === 'closed'
  ) {
    out.status = status;
  }
  const priority = typeof sp.priority === 'string' ? sp.priority : undefined;
  if (
    priority === 'low' ||
    priority === 'normal' ||
    priority === 'high' ||
    priority === 'urgent' ||
    priority === 'none'
  ) {
    out.priority = priority;
  }
  if (typeof sp.boardId === 'string' && sp.boardId.length > 0) {
    out.boardId = sp.boardId;
  }
  if (typeof sp.assigneeId === 'string' && sp.assigneeId.length > 0) {
    out.assigneeId = sp.assigneeId;
  }
  if (typeof sp.search === 'string' && sp.search.length > 0) {
    out.search = sp.search.slice(0, 200);
  }
  return out;
}
