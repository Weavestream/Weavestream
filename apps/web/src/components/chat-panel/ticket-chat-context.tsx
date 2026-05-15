'use client';

import { useCallback } from 'react';
import type { TicketDetail } from '../../lib/server-api';
import { useChatTicketPageContext } from './use-chat-page-context';

/**
 * Bridge that lets the server-rendered ticket detail page register
 * itself with the chat panel. The ticket is fetched real-time
 * server-side and projected to markdown via `ticketToMarkdown` before
 * mount, so the chat panel sees exactly the body the operator is
 * reading on-screen.
 *
 * Implicit by design (per the plan): visiting `/tickets/[ticketId]`
 * auto-attaches the ticket to the chat context — no extra button to
 * click. Leaving the page clears the snapshot.
 */
export function TicketChatContext({
  companyId,
  ticket,
  markdown,
}: {
  /** Resolved Weavestream company; null on the global tickets
   *  surface when the upstream client has no mapping. */
  companyId: string | null;
  ticket: TicketDetail;
  markdown: string;
}) {
  const getMarkdown = useCallback((): string => markdown, [markdown]);

  useChatTicketPageContext({
    companyId,
    ticketId: ticket.id,
    provider: ticket.provider,
    subject: ticket.subject || `Ticket ${ticket.displayId ?? ticket.id}`,
    getMarkdown,
  });
  return null;
}
