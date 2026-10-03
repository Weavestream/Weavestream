import { cache } from 'react';
import type {
  TicketActivityDto,
  TicketDetailDto,
  TicketListDto,
  TicketListFilter,
  TicketListResponse,
} from '@weavestream/shared';
import { serverApiFetch } from './core';

// ───────────────────────────────────────────────────────────────────
// Phase 12+: global admin ticket browse (read-only)
//
// Tickets live in the upstream system (NinjaOne today); these helpers
// only proxy the API. The "capability" probe is used by the admin
// shell to gate the sidebar entry without disclosing the underlying
// mapping/driver identity. Both routes are gated by
// `tickets.read.global` on the API.
// ───────────────────────────────────────────────────────────────────

export type TicketListItem = TicketListDto;
export type TicketDetail = TicketDetailDto;
export type TicketActivity = TicketActivityDto;
type TicketListPage = TicketListResponse;
export type TicketListFilters = TicketListFilter;

export const hasAnyTicketingIntegration = cache(async (): Promise<boolean> => {
  const res = await serverApiFetch<{ enabled: boolean }>(`/tickets/_capability`);
  return res.ok && res.data?.enabled === true;
});

export async function listTickets(
  params: TicketListFilters & { cursor?: string | null } = {},
): Promise<TicketListPage> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.priority) q.set('priority', params.priority);
  if (params.boardId) q.set('boardId', params.boardId);
  if (params.search) q.set('search', params.search);
  if (params.cursor) q.set('cursor', params.cursor);
  const path = `/tickets${q.toString() ? `?${q.toString()}` : ''}`;
  const res = await serverApiFetch<TicketListPage>(path);
  if (!res.ok || !res.data) return { records: [], cursor: null };
  return res.data;
}

export async function getTicket(
  ticketId: string,
): Promise<TicketDetail | null> {
  const res = await serverApiFetch<TicketDetail>(
    `/tickets/${encodeURIComponent(ticketId)}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}
