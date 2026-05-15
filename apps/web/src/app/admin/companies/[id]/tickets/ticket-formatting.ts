import type { TagTone } from '../../../../../components/ui';
import type { TicketDetail, TicketListItem } from '../../../../../lib/server-api';

/**
 * Shared display helpers for the ticket list + detail surfaces. The
 * driver normalises everything to `TicketListDto` / `TicketDetailDto`,
 * so these helpers stay provider-agnostic — they read the canonical
 * fields and fall back to the raw provider strings on the detail
 * chips when we have them.
 */

export function formatTicketStatus(row: TicketListItem | TicketDetail): string {
  if (row.statusLabel && row.statusLabel.trim().length > 0) {
    return prettyCase(row.statusLabel);
  }
  return capitalise(row.status);
}

export function formatTicketPriority(p: TicketListItem['priority']): string {
  if (p === 'none') return 'No priority';
  return capitalise(p);
}

export function formatTicketBoard(row: TicketListItem | TicketDetail): string {
  if (row.boardName && row.boardName.trim().length > 0) return row.boardName;
  if (row.typeLabel && row.typeLabel.trim().length > 0) return row.typeLabel;
  return 'Ticket';
}

export function statusTone(status: TicketListItem['status']): TagTone {
  switch (status) {
    case 'open':
      return 'info';
    case 'pending':
      return 'warn';
    case 'resolved':
      return 'ok';
    case 'closed':
      return 'outline';
    default:
      return 'outline';
  }
}

export function priorityTone(p: TicketListItem['priority']): TagTone {
  switch (p) {
    case 'urgent':
      return 'danger';
    case 'high':
      return 'warn';
    case 'normal':
      return 'info';
    case 'low':
      return 'outline';
    case 'none':
      return 'outline';
    default:
      return 'outline';
  }
}

function capitalise(s: string): string {
  if (!s) return s;
  const first = s.charAt(0).toUpperCase();
  return first + s.slice(1).toLowerCase();
}

/**
 * Provider status strings often arrive in SHOUTY_SNAKE_CASE
 * ("WAITING_ON_CUSTOMER") or kebab-case. Render them as
 * "Waiting on customer" without losing the original semantics.
 */
function prettyCase(s: string): string {
  const cleaned = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return cleaned;
  const lower = cleaned.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
