import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getCompanyDetail,
  getCompanyTicket,
  getCompanyTicketingCapability,
  getMe,
  getSettings,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { TicketChatContext } from '../../../../../../components/chat-panel/ticket-chat-context';
import { TicketDetailView } from './ticket-detail-view';
import {
  formatTicketBoard,
  formatTicketPriority,
  formatTicketStatus,
  priorityTone,
  statusTone,
} from '../ticket-formatting';
import { ticketToMarkdown } from './ticket-to-markdown';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; ticketId: string }>;
}): Promise<Metadata> {
  const { ticketId } = await params;
  return { title: `Ticket ${ticketId}` };
}

/**
 * Phase 12 — single-ticket detail. Real-time fetch from the upstream
 * ticketing system; nothing is persisted in Weavestream. Visiting the
 * page auto-attaches the ticket markdown to the chat panel context so
 * the operator can immediately ask the AI to draft an article.
 */
export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string; ticketId: string }>;
}) {
  const { id: companyId, ticketId } = await params;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());

  const [companyRes, hasTicketing] = await Promise.all([
    getCompanyDetail(companyId),
    getCompanyTicketingCapability(companyId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  if (!hasTicketing) notFound();

  const ticket = await getCompanyTicket(companyId, ticketId);
  if (!ticket) notFound();

  const subject = ticket.subject || '(no subject)';
  const display = ticket.displayId ?? ticket.id;
  const markdown = ticketToMarkdown(ticket);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(
          term,
          company,
          {
            label: 'Tickets',
            href: `/admin/companies/${companyId}/tickets`,
          },
          { label: display, mono: true },
        )}
        title={subject}
        description={`${formatTicketBoard(ticket)} · ${display}`}
      />
      <PageBody>
        <Panel
          title={
            <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
              <Tag tone={statusTone(ticket.status)}>
                {formatTicketStatus(ticket)}
              </Tag>
              <Tag tone={priorityTone(ticket.priority)}>
                {formatTicketPriority(ticket.priority)}
              </Tag>
              {ticket.assignee?.name && (
                <Tag tone="info">Assigned: {ticket.assignee.name}</Tag>
              )}
              {ticket.requester?.name && (
                <Tag tone="outline">Requester: {ticket.requester.name}</Tag>
              )}
            </span>
          }
        >
          <TicketDetailView ticket={ticket} actorId={me.id} />
        </Panel>
      </PageBody>
      <TicketChatContext
        companyId={companyId}
        ticket={ticket}
        markdown={markdown}
      />
    </>
  );
}
