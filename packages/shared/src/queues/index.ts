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
  pwnedCheck: 'pwned-check',
  companyExport: 'company-export',
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

// ---------------------------------------------------------------------
// pwned-check queue (Phase 10 — password vault)
// ---------------------------------------------------------------------
//
// The API enqueues a job whenever a password's ciphertext changes. The
// worker fetches the (already-decrypted-at-enqueue-time) SHA-1 prefix +
// suffix via k-anonymity, queries HaveIBeenPwned's /range/ endpoint,
// and writes `pwned_count` + `pwned_checked_at` back to the row.
//
// The plaintext never leaves the API — only the 5-char hex prefix
// travels over the wire to HIBP, and neither that prefix nor the full
// hash is stored in the queue payload. We persist the FULL sha-1
// (40-char hex) in the job body strictly for the HTTP comparison; the
// API is responsible for NOT logging it and for TTL'ing the job
// aggressively so it doesn't linger in Redis dumps.

export const pwnedCheckJobSchema = z.object({
  kind: z.literal('password'),
  passwordId: z.string().uuid(),
  companyId: z.string().uuid(),
  /**
   * Uppercase hex SHA-1 (40 chars) of the plaintext, computed in the
   * API at enqueue time. The worker splits this into prefix[0..5]
   * (sent to hibp) + suffix[5..] (compared locally).
   */
  sha1Hex: z.string().regex(/^[0-9A-F]{40}$/),
});
export type PwnedCheckJob = z.infer<typeof pwnedCheckJobSchema>;

export const PwnedCheckJobNames = {
  password: 'password',
} as const;
export type PwnedCheckJobName =
  (typeof PwnedCheckJobNames)[keyof typeof PwnedCheckJobNames];

// ---------------------------------------------------------------------
// company-export queue (PDF vault archive)
// ---------------------------------------------------------------------
//
// The API enqueues an `export` job when an admin requests a company PDF.
// The worker gathers all company data, builds a PDFKit document, uploads
// the buffer to MinIO, and stores the storage key in the job return value
// so the API can re-mint a presigned URL on every status poll.
//
// After generating the PDF the worker also enqueues a `cleanup` job with
// a 4-hour delay to delete the MinIO object — the PDF is ephemeral and
// must not linger indefinitely since it may contain plaintext passwords.
//
// Sensitive fields in the payload (the optional user-supplied PDF
// password) are NEVER stored as plaintext in Redis. The API encrypts
// them via `SecretEncryptionService` (the same envelope used for
// password-vault rows) before enqueueing, and the worker decrypts at
// dispatch time. Even if a Redis dump leaks, the only thing recoverable
// from a queued job is the encrypted blob — useless without the active
// `PASSWORD_ENCRYPTION_KEY`.

export const companyExportJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('export'),
    exportId: z.string().uuid(),
    companyId: z.string().uuid(),
    includePasswords: z.boolean(),
    /**
     * Opaque ciphertext (base64) produced by `SecretEncryptionService.encrypt`.
     * If absent, the resulting PDF is unencrypted. The worker decrypts
     * this just before handing it to PDFKit; the plaintext lives in
     * memory for milliseconds and is never logged.
     */
    pdfPasswordCiphertext: z.string().optional(),
  }),
  z.object({
    kind: z.literal('cleanup'),
    /** MinIO storage key to delete after the TTL window. */
    storageKey: z.string(),
    companyId: z.string().uuid(),
  }),
]);

export type CompanyExportJob = z.infer<typeof companyExportJobSchema>;

export const CompanyExportJobNames = {
  export: 'export',
  cleanup: 'cleanup',
} as const;
export type CompanyExportJobName =
  (typeof CompanyExportJobNames)[keyof typeof CompanyExportJobNames];

/**
 * Stored as the BullMQ job's `returnvalue` when the worker successfully
 * produces a PDF. The API reads this on every status poll and re-mints
 * a presigned GET URL against MinIO. Lives here (instead of inside
 * `apps/api`) so the worker can `import type { ExportJobResult }` from
 * the shared package without reaching across the package boundary.
 */
export interface ExportJobResult {
  companyId: string;
  storageKey: string;
  /** Bytes the rendered PDF occupies in MinIO. Surfaced in audit only. */
  sizeBytes: number;
}
