import type { TicketDetail } from '../../../../../lib/server-api';

/**
 * Project a `TicketDetailDto` to the markdown block the chat panel
 * inlines as system-prompt context. Same shape used by
 * `asset-format` / `domain-format`: heading, structured key/value
 * front-matter, full description, chronological activity stream
 * (including internal notes, per spec), and an `attachments` index.
 *
 * The raw provider-extras bag is NOT included — the AI rarely benefits
 * from un-normalised vendor fields and they tend to balloon the
 * context budget. Operators can still see them on the page via the
 * "Provider details" panel.
 */
export function ticketToMarkdown(ticket: TicketDetail): string {
  const lines: string[] = [];
  lines.push(`# ${ticket.subject || '(no subject)'}`);
  lines.push('');
  lines.push(`- ID: ${ticket.displayId ?? ticket.id}`);
  lines.push(`- Provider: ${ticket.provider}`);
  if (ticket.companyName) {
    lines.push(`- Company: ${ticket.companyName}`);
  } else if (ticket.externalClientId) {
    lines.push(`- Upstream client id: ${ticket.externalClientId} (unmapped)`);
  }
  if (ticket.statusLabel) {
    lines.push(`- Status: ${ticket.statusLabel} (${ticket.status})`);
  } else {
    lines.push(`- Status: ${ticket.status}`);
  }
  lines.push(`- Priority: ${ticket.priority}`);
  if (ticket.boardName) lines.push(`- Board: ${ticket.boardName}`);
  if (ticket.typeLabel) lines.push(`- Type: ${ticket.typeLabel}`);
  if (ticket.requester?.name) {
    lines.push(
      `- Requester: ${ticket.requester.name}${
        ticket.requester.email ? ` <${ticket.requester.email}>` : ''
      }`,
    );
  }
  if (ticket.assignee?.name) {
    lines.push(
      `- Assignee: ${ticket.assignee.name}${
        ticket.assignee.email ? ` <${ticket.assignee.email}>` : ''
      }`,
    );
  }
  if (ticket.createdAt) lines.push(`- Created: ${ticket.createdAt}`);
  if (ticket.updatedAt) lines.push(`- Updated: ${ticket.updatedAt}`);

  if (ticket.description && ticket.description.trim().length > 0) {
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(ticket.description.trim());
  }

  if (ticket.activities.length > 0) {
    lines.push('');
    lines.push('## Activity');
    for (const a of ticket.activities) {
      lines.push('');
      const author = a.author?.name ? ` — ${a.author.name}` : '';
      const stamp = a.occurredAt ? ` · ${a.occurredAt}` : '';
      lines.push(`### ${a.label}${author}${stamp}`);
      if (a.rawKind) {
        lines.push(`_(${a.rawKind})_`);
      }
      if (a.body && a.body.trim().length > 0) {
        lines.push('');
        lines.push(a.body.trim());
      }
    }
  }

  if (ticket.attachments.length > 0) {
    lines.push('');
    lines.push('## Attachments');
    for (const att of ticket.attachments) {
      const size = att.sizeBytes != null ? ` (${att.sizeBytes} bytes)` : '';
      const ct = att.contentType ? ` [${att.contentType}]` : '';
      lines.push(`- ${att.name}${size}${ct}`);
    }
  }

  return lines.join('\n').trim();
}
