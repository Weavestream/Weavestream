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
  // Phase 11 — integration framework. Two queues so the orchestrator
  // job (which owns the `IntegrationSyncRun` row) and the per-mapping
  // children (which fetch + upsert) have independent concurrency caps,
  // retry policies, and BullMQ metrics.
  integrationSyncOrchestrator: 'integration-sync-orchestrator',
  integrationSyncMapping: 'integration-sync-mapping',
  // Alerts feature. `scan` is the cron tick (loads enabled time/state-based
  // configs and enqueues `send` jobs per match); `send` is also enqueued by
  // `AlertEmitterService` for real-time RECORD_EVENT / PASSWORD_EVENT.
  alerts: 'alerts',
  // Scheduled Postgres exports (backup feature). Two job shapes:
  //   - `run`    — produce a dump + manifest for a BackupConfig /
  //                BackupRun pair. Enqueued both by the repeatable
  //                cron and by the "Run now" admin action.
  //   - `prune`  — GFS retention pass. Enqueued by the run processor
  //                itself on success so cleanup is part of the same
  //                lane and inherits the same advisory-lock guard.
  backup: 'backup',
  // Cloudflare Zero Trust Gateway list integration. Cron-driven drift
  // sweep (one job per integration, runs every registered list).
  // Outbound pushes go through Cloudflare's synchronous PATCH endpoint
  // so no async finalize queue is needed.
  cloudflareDriftSweep: 'cloudflare-drift-sweep',
  // Phase 7 — soft-deleted Upload reaper. One repeatable `scheduled`
  // job sweeps Upload rows whose `deletedAt` is older than
  // `UPLOAD_REAPER_RETENTION_DAYS`, removes the original + thumbnail
  // bytes from local storage, then hard-deletes the row (the
  // `uploads_search_index_delete` trigger purges the search row and
  // `companies.logo_upload_id` is `ON DELETE SET NULL`). Set
  // `UPLOAD_REAPER_CRON=off` to disable scheduled reaping.
  uploadReaper: 'upload-reaper',
  // Mobile Phase 4 — AI article list summaries. `generate` produces one
  // summary for one (article, revision); the repeatable `sweep` is the
  // durability backstop + spend governor (drains `ai_summary_at IS
  // NULL` in paced batches). Gated on AiSetting.enabled && autoSummaries.
  articleSummary: 'article-summary',
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
// The worker gathers all company data, builds a PDFKit document, writes
// the buffer to local filesystem storage, and stores the storage key in
// the job return value so the API can serve the file on every status
// poll via its same-origin streaming endpoint.
//
// After generating the PDF the worker also enqueues a `cleanup` job with
// a 4-hour delay to delete the file — the PDF is ephemeral and must not
// linger indefinitely since it may contain plaintext passwords.
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
    /** Storage key to delete after the TTL window. */
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
 * produces a PDF. The API reads this on every status poll and serves the
 * file through its same-origin streaming endpoint. Lives here (instead
 * of inside `apps/api`) so the worker can `import type { ExportJobResult }`
 * from the shared package without reaching across the package boundary.
 */
export interface ExportJobResult {
  companyId: string;
  storageKey: string;
  /** Bytes the rendered PDF occupies on disk. Surfaced in audit only. */
  sizeBytes: number;
}

// ---------------------------------------------------------------------
// integration-sync-orchestrator queue (Phase 11)
// ---------------------------------------------------------------------
//
// One job per "go run a sync now" decision — either fired by the
// scheduler (cron registrar) or by an operator pressing "Run sync"
// in the admin UI. The orchestrator creates an `IntegrationSyncRun`
// row, fans out one child job per enabled `IntegrationCompanyMapping`,
// then aggregates totals into the parent run.
//
// Manual jobs carry the `triggeredBy` user id so the audit log can
// attribute the run; scheduled jobs carry NULL.

export const integrationSyncOrchestratorJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scheduled'),
    integrationId: z.string().uuid(),
    mode: z.enum(['incremental', 'full']).optional(),
  }),
  z.object({
    kind: z.literal('manual'),
    integrationId: z.string().uuid(),
    /**
     * Rolling-upgrade compatibility: jobs enqueued by a pre-DAG API
     * (≤ the release before reconstruction sync) carry no `syncRunId`.
     * Those jobs survive the upgrade in Redis, so the field must stay
     * optional until every supported upgrade path has drained them —
     * the worker falls back to the legacy most-recent-queued-run lookup
     * when it is absent. New producers always set it.
     */
    syncRunId: z.string().uuid().optional(),
    triggeredBy: z.string().uuid(),
    mode: z.enum(['incremental', 'full']).default('incremental'),
    /**
     * When true the worker computes every resolution but writes nothing
     * — used by the admin UI's "Test sync" button to validate mappings.
     */
    dryRun: z.boolean().default(false),
  }),
]);

export type IntegrationSyncOrchestratorJob = z.infer<
  typeof integrationSyncOrchestratorJobSchema
>;

export const IntegrationSyncOrchestratorJobNames = {
  scheduled: 'scheduled',
  manual: 'manual',
} as const;
export type IntegrationSyncOrchestratorJobName =
  (typeof IntegrationSyncOrchestratorJobNames)[keyof typeof IntegrationSyncOrchestratorJobNames];

// ---------------------------------------------------------------------
// integration-sync-mapping queue (Phase 11)
// ---------------------------------------------------------------------
//
// One job per (sync_run, integration_company_mapping). The processor
// loads the driver, walks paginated source records, runs match-by-key
// resolution, upserts assets + AssetFieldValues inside a transaction,
// and writes a row into `integration_sync_run_company_results`.

export const integrationSyncMappingJobSchema = z.object({
  syncRunId: z.string().uuid(),
  integrationCompanyMappingId: z.string().uuid(),
  /**
   * Phase 11.1 — every per-mapping job is scoped to a single
   * `IntegrationResource` so the orchestrator fans out
   * (mappings × enabled-resources) jobs. Each job runs an
   * independent `runMapping` against its resource's layout +
   * field mappings; per-resource totals roll up into the
   * mapping's `IntegrationSyncRunCompanyResult.totals.byResource`.
   */
  resourceId: z.string().uuid(),
  mode: z.enum(['incremental', 'full']).default('incremental'),
  stageIndex: z.number().int().nonnegative().optional(),
  /**
   * Present on every job the DAG-aware orchestrator enqueues: the full
   * dependency-ordered resource set the single per-mapping job executes.
   *
   * Absent exactly on legacy-generation jobs — a pre-DAG orchestrator
   * fanned out one job per (mapping, resource) and those jobs survive an
   * upgrade in Redis. The worker keys its compatibility branch on this
   * field (`resourceIds` absent ⇒ legacy per-resource semantics), so it
   * must stay optional until every supported upgrade path has drained
   * pre-DAG queues. Do not make it required.
   */
  resourceIds: z.array(z.string().uuid()).max(64).optional(),
  auditActorId: z.string().uuid().nullable().optional(),
  dryRun: z.boolean().default(false),
}).superRefine((job, ctx) => {
  if (job.resourceIds && new Set(job.resourceIds).size !== job.resourceIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resourceIds'],
      message: 'resourceIds must be unique',
    });
  }
  if (job.resourceIds && !job.resourceIds.includes(job.resourceId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resourceIds'],
      message: 'resourceIds must contain resourceId',
    });
  }
});

export type IntegrationSyncMappingJob = z.infer<
  typeof integrationSyncMappingJobSchema
>;

export const IntegrationSyncMappingJobNames = {
  syncMapping: 'sync-mapping',
} as const;
export type IntegrationSyncMappingJobName =
  (typeof IntegrationSyncMappingJobNames)[keyof typeof IntegrationSyncMappingJobNames];

// ---------------------------------------------------------------------
// alerts queue (alerts feature)
// ---------------------------------------------------------------------
//
// Two job shapes routed by name:
//   - `scan`  — repeatable cron tick. The processor loads enabled
//               SINGLE_EXPIRATION / EXPIRATION_LIST / WEBSITE_DOWN
//               configs, evaluates them, and fans out one `send`
//               child per match. RECORD_EVENT / PASSWORD_EVENT are
//               handled in-process by `AlertEmitterService` and
//               never see this lane.
//   - `send`  — actually delivers an email via `EmailService.send`.
//               Enqueued by both the scan processor and the
//               real-time emitter. The payload carries the rendered
//               subject + body so the worker doesn't need access to
//               domain logic.
//
// `triggerKey` is the dedup key used to upsert an `AlertTrigger`
// row when the send completes — keeps retries from double-sending.

export const alertsScanJobSchema = z.object({
  kind: z.literal('scan'),
});
export type AlertsScanJob = z.infer<typeof alertsScanJobSchema>;

export const alertsSendJobSchema = z.object({
  kind: z.literal('send'),
  alertConfigId: z.string().uuid(),
  triggerKey: z.string().min(1).max(500),
  // One-or-more recipient addresses. Snapshotted at enqueue time so a
  // later edit to the AlertConfig recipient list doesn't redirect an
  // already-queued send.
  recipientEmails: z.array(z.string().email()).min(1),
  subject: z.string().min(1).max(255),
  text: z.string().min(1),
  html: z.string().optional(),
});
export type AlertsSendJob = z.infer<typeof alertsSendJobSchema>;

export const alertsJobSchema = z.discriminatedUnion('kind', [
  alertsScanJobSchema,
  alertsSendJobSchema,
]);
export type AlertsJob = z.infer<typeof alertsJobSchema>;

export const AlertsJobNames = {
  scan: 'scan',
  send: 'send',
} as const;
export type AlertsJobName =
  (typeof AlertsJobNames)[keyof typeof AlertsJobNames];

// ---------------------------------------------------------------------
// backup queue (scheduled Postgres exports)
// ---------------------------------------------------------------------
//
// Two job shapes routed by `kind`:
//   - `run`    - produce a `pg_dump --format=custom` file and a
//                `*.manifest.json` sidecar under
//                `/var/lib/weavestream/backup` (a host-bound directory
//                from compose.yml). `backupRunId` references a
//                pre-created `BackupRun` row so the API can poll
//                status without talking to BullMQ directly.
//   - `prune`  - apply GFS retention (keep the most recent N dailies,
//                weeklies, and monthlies) for a config. Enqueued by
//                the run processor on success.
//
// The processor takes a Postgres advisory lock around the whole job
// so a second run that fires while one is in flight fails fast with
// `error = 'concurrent'` instead of racing.

export const backupRunJobSchema = z.object({
  kind: z.literal('run'),
  configId: z.string().uuid(),
  /**
   * Pre-allocated `BackupRun` row id. The "Run now" admin action
   * mints a `MANUAL` row up-front and passes its id so the UI can
   * poll status by run id. The repeatable cron-fired version omits
   * this field; the consumer creates a `SCHEDULED` row inline.
   */
  backupRunId: z.string().uuid().optional(),
});
export type BackupRunJob = z.infer<typeof backupRunJobSchema>;

export const backupPruneJobSchema = z.object({
  kind: z.literal('prune'),
  configId: z.string().uuid(),
});
export type BackupPruneJob = z.infer<typeof backupPruneJobSchema>;

export const backupJobSchema = z.discriminatedUnion('kind', [
  backupRunJobSchema,
  backupPruneJobSchema,
]);
export type BackupJob = z.infer<typeof backupJobSchema>;

export const BackupJobNames = {
  run: 'run',
  prune: 'prune',
} as const;
export type BackupJobName =
  (typeof BackupJobNames)[keyof typeof BackupJobNames];

// ---------------------------------------------------------------------
// cloudflare-drift-sweep queue (Cloudflare Zero Trust Gateway Lists)
// ---------------------------------------------------------------------
//
// One repeatable job per Cloudflare integration registered with a
// non-null `syncCron`. The processor enumerates every CloudflareIpList
// row owned by the integration, fetches Cloudflare's current items, and
// stores `driftStatus` + `driftDetails` per list. Pushes use the
// synchronous Gateway PATCH endpoint, so there's no async finalize lane.

export const cloudflareDriftSweepJobSchema = z.object({
  integrationId: z.string().uuid(),
});
export type CloudflareDriftSweepJob = z.infer<
  typeof cloudflareDriftSweepJobSchema
>;

export const CloudflareDriftSweepJobNames = {
  scheduled: 'scheduled',
  manual: 'manual',
} as const;
export type CloudflareDriftSweepJobName =
  (typeof CloudflareDriftSweepJobNames)[keyof typeof CloudflareDriftSweepJobNames];

// ---------------------------------------------------------------------
// upload-reaper queue (Phase 7 — soft-delete cleanup)
// ---------------------------------------------------------------------
//
// One repeatable `scheduled` job, registered on API boot. The processor
// loads Upload rows whose `deletedAt` is older than the configured
// retention window, removes the original + thumbnail bytes from local
// storage, then hard-deletes the row. A Postgres advisory lock guards
// concurrent sweeps so two workers can't race over the same batch.
//
// No payload fields today — the cron pattern, retention window, and
// batch size all come from env at consume time. Wrapping in a schema
// anyway keeps the consumer boundary uniform with other queues and
// leaves room for a future ad-hoc "reap now" admin trigger.

export const uploadReaperJobSchema = z.object({
  kind: z.literal('scheduled'),
});
export type UploadReaperJob = z.infer<typeof uploadReaperJobSchema>;

export const UploadReaperJobNames = {
  scheduled: 'scheduled',
} as const;
export type UploadReaperJobName =
  (typeof UploadReaperJobNames)[keyof typeof UploadReaperJobNames];

// ---------------------------------------------------------------------
// article-summary queue (Mobile Phase 4 — AI article list summaries)
// ---------------------------------------------------------------------
//
// Two job shapes routed by `kind`:
//   - `generate` — produce one summary for one (article, revision).
//                  Enqueued post-commit by direct article writes when
//                  the feature gate (`AiSetting.enabled && autoSummaries
//                  && baseUrl && defaultModel`) was ON inside the write
//                  transaction, and by the sweep. The integration
//                  writer NEVER enqueues inline — it runs inside the
//                  sync runner's long page transaction, where a delayed
//                  job could execute pre-commit, read the old revision,
//                  skip as superseded, and strand the summary; its rows
//                  surface as pending and the sweep collects them.
//   - `sweep`    — repeatable reconciliation tick. Drains articles with
//                  `ai_summary_at IS NULL` (the pending marker) in
//                  paced batches, healing enqueue-time Redis failures,
//                  pre-commit skips, rollback orphans, and crashed
//                  jobs (a failed job with the same id is `retry()`ed
//                  rather than re-added — BullMQ dedups adds against
//                  retained failed jobs). The batch cap × interval is
//                  also the spend governor for bulk integration
//                  imports.
//
// Payload-generation doctrine (this is a NEW queue, so no legacy
// generations exist by construction): the `kind` discriminator is the
// extension point; any field added later must stay optional until every
// older producer's jobs have drained from Redis.

export const articleSummaryGenerateJobSchema = z.object({
  kind: z.literal('generate'),
  articleId: z.string().uuid(),
  companyId: z.string().uuid(),
  /**
   * The article revision this job was enqueued FOR. The worker skips
   * before any egress when the row's current revision differs, and the
   * write-back predicate re-checks it — per-revision jobs mean a rapid
   * edit burst spends at most one completion (the last revision's).
   */
  revision: z.number().int().min(1),
  correlationId: z.string().uuid().optional(),
});
export type ArticleSummaryGenerateJob = z.infer<
  typeof articleSummaryGenerateJobSchema
>;

export const articleSummarySweepJobSchema = z.object({
  kind: z.literal('sweep'),
});
export type ArticleSummarySweepJob = z.infer<
  typeof articleSummarySweepJobSchema
>;

export const articleSummaryJobSchema = z.discriminatedUnion('kind', [
  articleSummaryGenerateJobSchema,
  articleSummarySweepJobSchema,
]);
export type ArticleSummaryJob = z.infer<typeof articleSummaryJobSchema>;

export const ArticleSummaryJobNames = {
  generate: 'generate',
  sweep: 'sweep',
} as const;
export type ArticleSummaryJobName =
  (typeof ArticleSummaryJobNames)[keyof typeof ArticleSummaryJobNames];

/**
 * Deterministic custom job id for a `generate` job — shared so the API
 * producer and the worker's sweep construct byte-identical ids (the id
 * IS the dedup key between them). COLON-FREE deliberately: BullMQ
 * reserves `:` in custom ids (currently a compatibility exception, slated
 * to become a hard rejection).
 */
export function articleSummaryJobId(
  articleId: string,
  revision: number,
): string {
  return `article-summary-${articleId}-${revision}`;
}

/** Repeatable sweep tick's fixed id (one lane, idempotent registration). */
export const ARTICLE_SUMMARY_SWEEP_JOB_ID = 'article-summary-sweep';
