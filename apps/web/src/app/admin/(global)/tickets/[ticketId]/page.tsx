import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  getMe,
  getTicket,
} from '../../../../../lib/server-api';
import { hasCapability } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../components/ui';
import { TicketChatContext } from '../../../../../components/chat-panel/ticket-chat-context';
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
  params: Promise<{ ticketId: string }>;
}): Promise<Metadata> {
  const { ticketId } = await params;
  return { title: `Ticket ${ticketId}` };
}

/**
 * Phase 12+ — global admin ticket detail. Real-time fetch from the
 * upstream ticketing system; nothing is persisted in Weavestream.
 * Visiting the page auto-attaches the ticket markdown to the chat
 * panel context so the operator can immediately ask the AI to draft
 * an article — the chat panel's "Save as article" dialog handles the
 * company picker (defaulting to the resolved company when present).
 */
export default async function AdminTicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  const me = (await getMe())!;
  if (!hasCapability(me, 'TICKETS_READ')) redirect('/admin');

  const ticket = await getTicket(ticketId);
  if (!ticket) notFound();

  const subject = ticket.subject || '(no subject)';
  const display = ticket.displayId ?? ticket.id;
  const markdown = ticketToMarkdown(ticket);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Tickets', href: '/admin/tickets' },
          { label: display, mono: true },
        ]}
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
              {ticket.companyId && ticket.companyName ? (
                <Tag tone="info">
                  <Link
                    href={`/admin/companies/${ticket.companyId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {ticket.companyName}
                  </Link>
                </Tag>
              ) : ticket.externalClientId ? (
                <Tag tone="outline">
                  Unmapped client {ticket.externalClientId}
                </Tag>
              ) : null}
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
        companyId={ticket.companyId}
        ticket={ticket}
        markdown={markdown}
      />
    </>
  );
}
