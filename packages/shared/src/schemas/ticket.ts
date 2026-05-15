import { z } from 'zod';

/**
 * Phase 12 — read-only ticket browse surface backed by an external
 * ticketing system (currently NinjaOne; the DTO shape is intentionally
 * generic so a second driver can plug in without changing the web UI).
 *
 * Tickets are NEVER persisted in the Weavestream database. Every list /
 * detail request hits the upstream system in real time, so these DTOs
 * are validated at the API boundary only (no Prisma model). The driver
 * normalises whatever the upstream returns into this shape; provider-
 * specific extras flow through the `raw` bag on the detail DTO for the
 * "Provider details" panel.
 *
 * Web UI consumes only the normalised fields below; `raw` is rendered
 * generically as a key/value JSON block.
 */

/**
 * Status buckets are normalised so the generic list filter works
 * across providers. Each driver maps its native status set (open,
 * resolved, closed, archived, …) onto this canonical 4-state space.
 */
export const ticketStatusBucketSchema = z.enum([
  'open',
  'pending',
  'resolved',
  'closed',
]);
export type TicketStatusBucket = z.infer<typeof ticketStatusBucketSchema>;

/**
 * Priority buckets are normalised the same way. Providers without
 * explicit priorities (e.g. some forum-style desks) report `none`.
 */
export const ticketPrioritySchema = z.enum([
  'low',
  'normal',
  'high',
  'urgent',
  'none',
]);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

/**
 * Minimal person reference returned alongside a ticket. `id` is the
 * provider-side identifier (opaque to Weavestream) and `name` is the
 * display label. Either may be null when the upstream record is
 * partially populated.
 */
export const ticketPartySchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable().optional(),
});
export type TicketParty = z.infer<typeof ticketPartySchema>;

/**
 * List-row shape — slim. The list endpoint avoids a second round trip
 * per row, so anything that needs a fetch beyond the bulk list call
 * (e.g. activities) is intentionally omitted here and only loaded on
 * the detail endpoint.
 */
export const ticketListDtoSchema = z.object({
  id: z.string().min(1),
  /** Stable provider id (matches `id` on the detail DTO). */
  provider: z.string().min(1),
  /** Optional human-friendly short id (e.g. "T-1234") — falls back to `id`. */
  displayId: z.string().nullable(),
  subject: z.string(),
  status: ticketStatusBucketSchema,
  /** Raw provider status string (e.g. "WAITING_ON_CUSTOMER") for the detail chip. */
  statusLabel: z.string().nullable(),
  priority: ticketPrioritySchema,
  /** Provider's board / queue label (NinjaOne board, Zendesk group, …). */
  boardName: z.string().nullable(),
  /** Free-form provider type (e.g. "Incident", "Request", "Problem"). */
  typeLabel: z.string().nullable(),
  requester: ticketPartySchema.nullable(),
  assignee: ticketPartySchema.nullable(),
  /** ISO timestamps; null when the upstream record didn't populate them. */
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /**
   * Resolved Weavestream company UUID for the upstream tenant the
   * ticket belongs to. Null when the upstream client id has no
   * matching `IntegrationCompanyMapping` (and the UI renders an
   * "unmapped client" label instead of a link).
   */
  companyId: z.string().uuid().nullable().default(null),
  /** Display name for the resolved Weavestream company. */
  companyName: z.string().nullable().default(null),
  /**
   * Raw upstream tenant id (NinjaOne `clientId`). Always surfaced so
   * the UI can show "(unmapped client 123)" without leaking other
   * upstream fields.
   */
  externalClientId: z.string().nullable().default(null),
});
export type TicketListDto = z.infer<typeof ticketListDtoSchema>;

export const ticketListResponseSchema = z.object({
  records: z.array(ticketListDtoSchema),
  /** Opaque cursor for the next page; null when there is no more. */
  cursor: z.string().nullable(),
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

/**
 * One entry on the ticket activity timeline. Covers comments,
 * status-change log entries, internal notes — the driver normalises
 * each upstream activity into this shape. `kind` is generic so the UI
 * can apply consistent styling regardless of the source.
 */
export const ticketActivityKindSchema = z.enum([
  'comment',
  'internal_note',
  'status_change',
  'assignment',
  'system',
  'other',
]);
export type TicketActivityKind = z.infer<typeof ticketActivityKindSchema>;

export const ticketActivityDtoSchema = z.object({
  id: z.string().min(1),
  kind: ticketActivityKindSchema,
  /** Display label for the activity ("Comment", "Status changed", …). */
  label: z.string(),
  /** Markdown-formatted body for `comment` / `internal_note` kinds. */
  body: z.string().nullable(),
  author: ticketPartySchema.nullable(),
  /** ISO timestamp the activity was recorded at. Always present. */
  occurredAt: z.string(),
  /** Provider's native `kind`/`type` string, surfaced as a small chip. */
  rawKind: z.string().nullable(),
});
export type TicketActivityDto = z.infer<typeof ticketActivityDtoSchema>;

/**
 * Detail view payload. Everything the list row carries plus the
 * description body, full activity stream, attachments index, and a
 * `raw` bag for provider-specific extras the UI renders generically.
 */
export const ticketDetailDtoSchema = ticketListDtoSchema.extend({
  /** Markdown-formatted ticket body / description. Null when empty. */
  description: z.string().nullable(),
  /** Chronological activity stream (oldest first). */
  activities: z.array(ticketActivityDtoSchema),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        sizeBytes: z.number().int().nullable(),
        contentType: z.string().nullable(),
      }),
    )
    .default([]),
  /**
   * Provider-specific fields the normaliser couldn't slot onto the
   * canonical schema. Rendered as a collapsible JSON block on the
   * detail page so operators can still see custom NinjaOne fields,
   * board-specific properties, etc. without us hard-coding them.
   */
  raw: z.record(z.unknown()).default({}),
});
export type TicketDetailDto = z.infer<typeof ticketDetailDtoSchema>;

/**
 * Filter shape sent to `listTickets`. All optional — the API caps the
 * page size; the driver enforces what filters its upstream supports
 * and silently ignores the rest.
 */
export const ticketListFilterSchema = z.object({
  status: ticketStatusBucketSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  boardId: z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
  search: z.string().min(1).max(200).optional(),
});
export type TicketListFilter = z.infer<typeof ticketListFilterSchema>;
