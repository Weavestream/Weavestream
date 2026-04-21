/**
 * Shared BullMQ queue contracts.
 *
 * Both `apps/api` (producer) and `apps/worker` (consumer) import from
 * this file so job names and payload shapes stay in lockstep at the
 * type level. The discriminated union in `domainCheckJobSchema` lets
 * the consumer route on `kind` with exhaustive checks; adding a new
 * job kind is a one-line edit that the compiler then flags at every
 * call site.
 *
 * Runtime validation happens at the consumer boundary — see
 * `DomainChecksProcessor` — so a malformed payload produced by a
 * misbehaving CLI or future service cannot crash the worker.
 */
import { z } from 'zod';

/**
 * Every queue name flows through this registry. Adding a new queue:
 *   1. Add the name + a schema here.
 *   2. Register a producer in `apps/api/src/queues/queues.module.ts`.
 *   3. Register a consumer in `apps/worker/src/<kind>/<kind>.processor.ts`.
 */
export const QueueNames = {
  domainChecks: 'domain-checks',
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

// ---------------------------------------------------------------------
// domain-checks queue payloads
// ---------------------------------------------------------------------

export const scheduledDomainCheckJobSchema = z.object({
  kind: z.literal('scheduled'),
});

export const singleDomainCheckJobSchema = z.object({
  kind: z.literal('single'),
  domainId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  /**
   * Opaque trace id — populated by the api when an HTTP caller enqueues
   * a manual check so logs on both sides can be correlated. Optional
   * so the repeatable job's fan-out children don't have to invent one.
   */
  correlationId: z.string().uuid().optional(),
});

export const domainCheckJobSchema = z.discriminatedUnion('kind', [
  scheduledDomainCheckJobSchema,
  singleDomainCheckJobSchema,
]);

export type ScheduledDomainCheckJob = z.infer<typeof scheduledDomainCheckJobSchema>;
export type SingleDomainCheckJob = z.infer<typeof singleDomainCheckJobSchema>;
export type DomainCheckJob = z.infer<typeof domainCheckJobSchema>;

/**
 * BullMQ job-name constants inside the `domain-checks` queue. We use
 * distinct names (not just the discriminator) because BullMQ's UI /
 * metrics group by `name`, and so that `addRepeatable` idempotency is
 * scoped to the `scheduled` lane independently of ad-hoc `single`
 * submissions.
 */
export const DomainCheckJobNames = {
  scheduled: 'scheduled',
  single: 'single',
} as const;

export type DomainCheckJobName =
  (typeof DomainCheckJobNames)[keyof typeof DomainCheckJobNames];
