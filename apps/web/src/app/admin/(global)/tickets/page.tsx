import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  getMe,
  hasAnyTicketingIntegration,
  listTickets,
  type TicketListFilters,
} from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { TicketsBrowser } from './tickets-browser';

export const metadata: Metadata = { title: 'Tickets' };

/**
 * Phase 12+ — global admin tickets browse. Aggregates every ticket
 * the system's ticketing integration can see, with each row stitched
 * to a resolved Weavestream company (or a muted "(unmapped client …)"
 * label when no mapping exists). Filters + cursor live in the URL so
 * deep links survive cleanly.
 *
 * Admin-only: gated by `TICKETS_READ` capability (SUPER_ADMIN gets it
 * implicitly; elevated operators via MANAGER_PRESET). Portal users
 * never see the route or the sidebar entry.
 */
export default async function AdminTicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = (await getMe())!;
  if (!hasCapability(me, 'TICKETS_READ')) redirect('/admin');

  const sp = await searchParams;
  const filter = parseFilter(sp);
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : null;

  // Surface a clean "no integration configured" empty-state instead
  // of a generic 404 when the operator has the capability but no
  // ticketing integration is wired up yet.
  const enabled = await hasAnyTicketingIntegration();
  const page = enabled
    ? await listTickets({ ...filter, ...(cursor ? { cursor } : {}) })
    : { records: [], cursor: null };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Tickets' }]}
        title="Tickets"
        description="Browse live tickets from the connected helpdesk across every client. Open a ticket to ask the AI to draft a knowledge-base article from it."
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
            rows={page.records}
            cursor={page.cursor}
            filter={filter}
            activeCursor={cursor}
            actorId={me.id}
            integrationEnabled={enabled}
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
  if (typeof sp.search === 'string' && sp.search.length > 0) {
    out.search = sp.search.slice(0, 200);
  }
  return out;
}
