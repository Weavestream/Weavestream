import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type MonitoredDomain } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { domainHostnameSchema } from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { QueuesService } from '../../queues/queues.service.js';
import {
  CloudflareDriftSweepJobNames,
  QueueNames,
  type CloudflareDomainSyncResult,
  type CloudflareDomainSyncRunDto,
} from '@weavestream/shared';
import { IntegrationsService } from '../integrations.service.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import { cloudflareConfigSchema } from '../drivers/cloudflare/cloudflare.driver.js';
import { CloudflareApiError } from '../drivers/cloudflare/cloudflare-api.client.js';
import { DriverAuthError, DriverRateLimitError } from '../drivers/integration-driver.js';
import { describeError } from '../../common/describe-error.js';

/**
 * Lease covers the listing phase (the paginated zone and registration lists,
 * which may wait out 429 Retry-After). After listing the lease is renewed to
 * WRITE_LEASE_SEC and writes must finish within WRITE_DEADLINE_MS of that.
 */
const LISTING_LEASE_SEC = 3600;
const WRITE_LEASE_SEC = 900;
const WRITE_DEADLINE_MS = 600_000;
/** Delete KEYS[1] only if it still holds ARGV[1] (our token). */
const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/** Re-arm KEYS[1]'s TTL to ARGV[2] only if it still holds ARGV[1]. */
const RENEW_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

const lockKey = (integrationId: string) => `lock:cf-registrar-sync:${integrationId}`;

/**
 * A queued or running run older than both leases cannot still be alive: the
 * worker died or the job was lost. It is reported, and settled, as failed.
 */
const STALE_RUN_MS = (LISTING_LEASE_SEC + WRITE_LEASE_SEC) * 1000;
const STALE_RUN_ERROR = 'Interrupted: the worker stopped before this run finished.';
/** Finished runs kept per integration (a 15-minute schedule ≈ one day). */
const KEEP_RUNS = 100;

const WORKER_META = { ip: 'worker', userAgent: 'worker' };

/** A sync failure whose message was written here for the operator to read. */
class RegistrarSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrarSyncError';
  }
}

/**
 * The text stored on a failed run, which the Domains tab shows and the audit
 * row records. Errors written for the operator (Cloudflare's answer, a
 * permission or rate-limit failure, this service's own checks) keep their
 * message: that is how an operator learns the token lacks a permission.
 * Anything else (a database or programming error) may carry query text or
 * file paths, so it becomes a fixed message plus the correlation id that
 * the full error is logged under.
 */
export function operatorMessage(err: unknown, correlationId: string): string {
  const known =
    err instanceof CloudflareApiError ||
    err instanceof DriverAuthError ||
    err instanceof DriverRateLimitError ||
    err instanceof RegistrarSyncError ||
    err instanceof HttpException;
  if (known) return describeError(err);
  return `The domain sync failed because of an internal error. Reference: ${correlationId}`;
}


/** Counts from one run; see CloudflareDomainSyncResult in @weavestream/shared. */
export type RegistrarSyncResult = CloudflareDomainSyncResult;

/**
 * Cloudflare registrar → MonitoredDomain sync.
 *
 * Cloudflare is the source of truth for registrar facts (registrar, expiry,
 * auto-renew, lock, nameservers); Weavestream owns everything else on the row
 * — which company it belongs to, the monitoring toggles, client visibility.
 * So a domain moved to a client company stays there, and the sync only ever
 * rewrites the registrar columns.
 *
 * Never deletes. A domain that disappears from the account (transferred out,
 * expired, moved to a different Cloudflare account) gets
 * `registrarMissingSince` stamped and keeps its history; an operator decides
 * whether to archive it.
 */
@Injectable()
export class CloudflareRegistrarSyncService {
  private readonly logger = new Logger(CloudflareRegistrarSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly queues: QueuesService,
  ) {}

  /**
   * "Sync domains now". Runs in the worker as a system job, like the
   * scheduled sweep, rather than inline in the request: the sync touches
   * domains across companies, which the request's tenant scope (correctly)
   * would refuse for anyone short of full global access. A queued run row is
   * written first, so the outcome (success, counts, or the error) is on
   * record whatever happens to the job; the Domains tab polls it.
   */
  async enqueue(integrationId: string, actorId: string): Promise<{ queued: true; runId: string }> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { driver: true, status: true, config: true },
    });
    if (!integration) throw new NotFoundException(`Integration ${integrationId} not found`);
    if (integration.driver !== 'cloudflare') {
      throw new BadRequestException(`Integration ${integrationId} is not a Cloudflare integration.`);
    }
    if (integration.status !== 'ACTIVE') {
      throw new BadRequestException('Activate the integration before syncing domains.');
    }
    const config = cloudflareConfigSchema.safeParse(integration.config);
    if (!config.success || !config.data.domainsCompanyId) {
      throw new BadRequestException(
        'Set "Sync domains into company" under Credentials before syncing domains.',
      );
    }
    await this.settleStaleRuns(integrationId);
    // A second job would only hit the lock. Say so now instead. (A sweep
    // could still start in between; its run is recorded the same way.)
    const active = await this.prisma.integrationSyncRun.findFirst({
      where: { integrationId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (active || (await this.redis.client.exists(lockKey(integrationId)))) {
      throw new ConflictException('A domain sync for this integration is already running.');
    }
    const run = await this.prisma.integrationSyncRun.create({
      data: { integrationId, kind: 'manual', status: 'queued', triggeredBy: actorId },
      select: { id: true },
    });
    try {
      await this.queues.get(QueueNames.cloudflareDriftSweep).add(
        CloudflareDriftSweepJobNames.manual,
        { integrationId, triggeredBy: actorId, runId: run.id },
        // The run row holds the outcome, so the job itself need not linger.
        { jobId: `manual-domains-${run.id}`, removeOnComplete: true, removeOnFail: true },
      );
    } catch (err) {
      await this.finishRun(run.id, 'failed', { error: 'Could not queue the sync job.' }, ['queued']);
      throw err;
    }
    return { queued: true, runId: run.id };
  }

  /** Latest run for the Domains tab; null before the first one. */
  async latestRun(integrationId: string): Promise<CloudflareDomainSyncRunDto | null> {
    const run = await this.prisma.integrationSyncRun.findFirst({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        kind: true,
        status: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        totals: true,
        error: true,
      },
    });
    if (!run) return null;
    // Report a dead run as failed without waiting for the next sync to settle it.
    const stale =
      (run.status === 'queued' || run.status === 'running') &&
      Date.now() - run.createdAt.getTime() > STALE_RUN_MS;
    return {
      id: run.id,
      kind: run.kind,
      status: stale ? 'failed' : run.status,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      result: (run.totals as RegistrarSyncResult | null) ?? null,
      error: stale ? STALE_RUN_ERROR : run.error,
    };
  }

  /**
   * One registrar sync. `runId` is the queued row of a manual request; a
   * scheduled sweep passes none and gets a row of its own. Either way the
   * row ends `succeeded` with the counts or `failed` with the error, and a
   * failure is audited, so a background failure is never silent.
   */
  async sync(
    integrationId: string,
    actorId: string | null,
    opts: { runId?: string; meta?: { ip: string; userAgent: string } } = {},
  ): Promise<RegistrarSyncResult> {
    const meta = opts.meta ?? WORKER_META;
    // A sweep for an integration without domain sync must not leave a run
    // row every 15 minutes. Manual runs were checked when queued.
    if (!opts.runId && !(await this.isEnabled(integrationId))) {
      return { enabled: false, created: 0, updated: 0, adopted: 0, missing: 0, skipped: 0 };
    }

    // One run per integration at a time: a manual sync overlapping the
    // scheduled sweep would otherwise race on the find-then-create below.
    const key = lockKey(integrationId);
    const token = randomUUID();
    const got = await this.redis.client.set(key, token, 'EX', LISTING_LEASE_SEC, 'NX');
    if (got !== 'OK') {
      const err = new ConflictException('A domain sync for this integration is already running.');
      if (opts.runId) await this.finishRun(opts.runId, 'failed', { error: err.message }, ['queued']);
      throw err;
    }
    // Called once listing is done: re-arm the lease for the write phase and
    // return the write deadline, or throw if the lease was lost meanwhile.
    const startWrites = async (): Promise<number> => {
      const renewed = await this.redis.client.eval(
        RENEW_IF_OWNER,
        1,
        key,
        token,
        String(WRITE_LEASE_SEC),
      );
      if (renewed !== 1) {
        throw new RegistrarSyncError('The sync lost its lock while reading Cloudflare. The next run will retry.');
      }
      return Date.now() + WRITE_DEADLINE_MS;
    };
    try {
      await this.settleStaleRuns(integrationId);
      const runId = await this.startRun(integrationId, opts.runId);
      // One id for the Cloudflare requests, the server log and, on an
      // internal failure, the reference the operator sees.
      const correlationId = randomUUID();
      let result: RegistrarSyncResult;
      try {
        result = await this.run(integrationId, actorId, meta, startWrites, runId, correlationId);
      } catch (err) {
        await this.recordFailure(runId, integrationId, actorId, meta, err, correlationId);
        throw err;
      }
      await this.finishRun(runId, 'succeeded', { totals: result });
      await this.pruneRuns(integrationId);
      return result;
    } finally {
      // Compare-and-delete in one step so we can only ever release our own
      // lock. A failure here must not mask the run's result; the lease
      // expires on its own.
      await this.redis.client
        .eval(RELEASE_IF_OWNER, 1, key, token)
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not release registrar sync lock (integration=${integrationId}): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }

  private async isEnabled(integrationId: string): Promise<boolean> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { config: true },
    });
    const config = cloudflareConfigSchema.safeParse(integration?.config);
    return config.success && !!config.data.domainsCompanyId;
  }

  /** Claims the queued manual row, or opens a row for a scheduled sweep. */
  private async startRun(integrationId: string, runId: string | undefined): Promise<string> {
    const now = new Date();
    if (!runId) {
      const run = await this.prisma.integrationSyncRun.create({
        data: { integrationId, kind: 'scheduled', status: 'running', startedAt: now },
        select: { id: true },
      });
      return run.id;
    }
    const claimed = await this.prisma.integrationSyncRun.updateMany({
      where: { id: runId, integrationId, status: 'queued' },
      data: { status: 'running', startedAt: now },
    });
    if (claimed.count !== 1) {
      throw new RegistrarSyncError('This sync was no longer queued when the worker picked it up.');
    }
    return runId;
  }

  private async finishRun(
    runId: string,
    status: 'succeeded' | 'failed',
    data: { totals?: RegistrarSyncResult; error?: string },
    from: Array<'queued' | 'running'> = ['running'],
  ): Promise<void> {
    await this.prisma.integrationSyncRun.updateMany({
      where: { id: runId, status: { in: from } },
      data: {
        status,
        finishedAt: new Date(),
        ...(data.totals ? { totals: data.totals as unknown as Prisma.InputJsonValue } : {}),
        ...(data.error ? { error: data.error } : {}),
      },
    });
  }

  /**
   * Marks the run failed and writes the failure audit row. The full error
   * goes to the server log only; the run row and the audit row get
   * {@link operatorMessage}. Both writes are best effort: the original error
   * is what the caller rethrows, and a database hiccup here must not
   * replace it.
   */
  private async recordFailure(
    runId: string,
    integrationId: string,
    actorId: string | null,
    meta: { ip: string; userAgent: string },
    err: unknown,
    correlationId: string,
  ): Promise<void> {
    this.logger.error(
      `Registrar sync failed (integration=${integrationId} run=${runId} correlationId=${correlationId}): ${describeError(err)}`,
    );
    const error = operatorMessage(err, correlationId);
    await this.finishRun(runId, 'failed', { error }).catch((e: unknown) =>
      this.logger.error(`Could not record failed registrar sync run ${runId}: ${describeError(e)}`),
    );
    await this.audit
      .log({
        actorId,
        action: AUDIT_ACTIONS.integration.cloudflareRegistrarSyncFailed,
        entityType: 'Integration',
        entityId: integrationId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: { runId, correlationId, error },
      })
      .catch((e: unknown) =>
        this.logger.error(`Could not audit failed registrar sync run ${runId}: ${describeError(e)}`),
      );
  }

  private async settleStaleRuns(integrationId: string): Promise<void> {
    await this.prisma.integrationSyncRun.updateMany({
      where: {
        integrationId,
        status: { in: ['queued', 'running'] },
        createdAt: { lt: new Date(Date.now() - STALE_RUN_MS) },
      },
      data: { status: 'failed', finishedAt: new Date(), error: STALE_RUN_ERROR },
    });
  }

  /** Keeps the newest KEEP_RUNS finished rows; the audit log is the long-term record. */
  private async pruneRuns(integrationId: string): Promise<void> {
    try {
      const old = await this.prisma.integrationSyncRun.findMany({
        where: { integrationId, status: { in: ['succeeded', 'failed'] } },
        orderBy: { createdAt: 'desc' },
        skip: KEEP_RUNS,
        select: { id: true },
      });
      if (old.length > 0) {
        await this.prisma.integrationSyncRun.deleteMany({
          where: { id: { in: old.map((r) => r.id) } },
        });
      }
    } catch (err) {
      this.logger.warn(`Could not prune registrar sync runs (integration=${integrationId}): ${describeError(err)}`);
    }
  }

  private async run(
    integrationId: string,
    actorId: string | null,
    meta: { ip: string; userAgent: string },
    startWrites: () => Promise<number>,
    runId: string,
    correlationId: string,
  ): Promise<RegistrarSyncResult> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });
    if (!integration) throw new NotFoundException(`Integration ${integrationId} not found`);
    if (integration.driver !== 'cloudflare') {
      throw new BadRequestException(`Integration ${integrationId} is not a Cloudflare integration.`);
    }
    if (integration.status !== 'ACTIVE') {
      throw new BadRequestException(`Integration ${integrationId} is not active.`);
    }

    const ctx = await this.integrations.loadDriverContext(integrationId);
    const config = cloudflareConfigSchema.parse(ctx.config);
    const result: RegistrarSyncResult = {
      enabled: false,
      created: 0,
      updated: 0,
      adopted: 0,
      missing: 0,
      skipped: 0,
    };
    // The id was resolved and permission-checked when the config was saved
    // (IntegrationsController). A slug without an id predates that check and
    // is ignored rather than trusted.
    if (!config.domainsCompanyId) return result;
    result.enabled = true;

    const company = await this.prisma.company.findUnique({
      where: { id: config.domainsCompanyId },
      select: { id: true, archivedAt: true },
    });
    if (!company || company.archivedAt) {
      throw new BadRequestException(
        'The company configured for domain sync no longer exists or is archived.',
      );
    }

    const driver = this.drivers.getSecurity(integration.driver);
    const domains = await driver.listRegistrarDomains(
      ctx.config,
      ctx.secret,
      {
        timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
        maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
        backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
      },
      correlationId,
    );
    const deadline = await startWrites();

    const now = new Date();
    const seen = new Set<string>();
    const createdNames: string[] = [];
    const adoptedNames: string[] = [];
    const createdIds: string[] = [];
    const skipped: Record<string, string> = {};

    // Checked immediately before every write: past the deadline the lock may
    // lapse, so stop rather than race a new run. Rows not reached are left
    // untouched for the next sweep, and nothing is stamped missing because
    // `seen` is incomplete.
    const assertBudget = () => {
      if (Date.now() > deadline) {
        throw new RegistrarSyncError('The sync ran out of time. Domains not reached are updated on the next run.');
      }
    };

    for (const d of domains) {
      const parsed = domainHostnameSchema.safeParse(d.name);
      if (!parsed.success) {
        this.logger.warn(`Skipping unparseable Cloudflare domain name (integration=${integrationId})`);
        continue;
      }
      const hostname = parsed.data;
      seen.add(hostname);

      const registrarData = {
        source: 'CLOUDFLARE' as const,
        integrationId,
        cloudflareAccountId: config.accountId,
        registrar: d.cloudflareRegistration ? 'Cloudflare' : d.registrar,
        registrarAutoRenew: d.autoRenew,
        registrarLocked: d.locked,
        registrarRegisteredAt: d.registeredAt,
        registrarExpiresAt: d.expiresAt,
        registrarStatuses: d.registryStatuses,
        nameservers: d.nameservers,
        registrarSyncedAt: now,
        registrarMissingSince: null,
      } satisfies Prisma.MonitoredDomainUncheckedUpdateInput;

      assertBudget();
      // Find-then-write runs under a transaction-scoped advisory lock on the
      // hostname, shared by every Cloudflare integration. Without it two
      // integrations bound to different companies could both find nothing
      // and both create the domain: the unique index is per company only.
      const outcome: WriteOutcome = await this.prisma
        .$transaction(async (tx): Promise<WriteOutcome> => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('weavestream:cf-registrar-hostname'), hashtext(${hostname}))`;
          // Archived rows included: an archive is an operator's decision and
          // must not be undone by recreating the domain next to it.
          const candidates = await tx.monitoredDomain.findMany({ where: { hostname } });
          const match = matchRow(candidates, integrationId, config.accountId, company.id);
          if (match.kind === 'update' || match.kind === 'adopt') {
            await tx.monitoredDomain.update({ where: { id: match.row.id }, data: registrarData });
            return match.kind === 'adopt' ? { kind: 'adopt' } : { kind: 'update' };
          }
          if (match.kind === 'skip') return match;
          const row = await tx.monitoredDomain.create({
            data: { ...registrarData, companyId: company.id, hostname, createdBy: actorId },
            select: { id: true },
          });
          return { kind: 'create', id: row.id };
        })
        .catch((err: unknown): WriteOutcome => {
          // Someone added the same hostname by hand in this company mid-run
          // (manual adds do not take the lock). Leave it; the next sweep
          // adopts it through matchRow.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            this.logger.warn(`Skipping ${hostname}: created concurrently (integration=${integrationId})`);
            return { kind: 'skip', reason: 'created concurrently' };
          }
          throw err;
        });

      if (outcome.kind === 'adopt') {
        result.adopted += 1;
        adoptedNames.push(hostname);
      } else if (outcome.kind === 'update') {
        result.updated += 1;
      } else if (outcome.kind === 'skip') {
        result.skipped += 1;
        skipped[hostname] = outcome.reason;
      } else {
        result.created += 1;
        createdNames.push(hostname);
        createdIds.push(outcome.id);
      }
    }

    // Owned rows Cloudflare stopped reporting. Only stamp the first time so
    // the date records when it went missing, not the latest sweep.
    const owned = await this.prisma.monitoredDomain.findMany({
      where: { integrationId, archivedAt: null, registrarMissingSince: null },
      select: { id: true, hostname: true },
    });
    const gone = owned.filter((r) => !seen.has(r.hostname));
    if (gone.length > 0) {
      assertBudget();
      await this.prisma.monitoredDomain.updateMany({
        where: { id: { in: gone.map((r) => r.id) } },
        data: { registrarMissingSince: now },
      });
      result.missing = gone.length;
    }

    // New domains get their first WHOIS/DNS/TLS check now, not at the
    // nightly sweep. Best effort: a queue hiccup must not fail the sync.
    for (const domainId of createdIds) {
      await this.queues
        .enqueueDomainCheck({ kind: 'single', domainId, actorId })
        .catch((err: unknown) =>
          this.logger.warn(
            `First check for synced domain ${domainId} not queued: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    await this.audit.log({
      actorId,
      action: AUDIT_ACTIONS.integration.cloudflareRegistrarSync,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        ...result,
        runId,
        seen: seen.size,
        skipped,
        createdHostnames: createdNames,
        adoptedHostnames: adoptedNames,
        missingHostnames: gone.map((r) => r.hostname),
      },
    });

    return result;
  }
}

/** What the per-hostname write did. */
type WriteOutcome =
  | { kind: 'update' }
  | { kind: 'adopt' }
  | { kind: 'skip'; reason: string }
  | { kind: 'create'; id: string };

export type RowMatch =
  | { kind: 'update' | 'adopt'; row: MonitoredDomain }
  | { kind: 'skip'; reason: string }
  | { kind: 'create' };

/**
 * What to do with one Cloudflare domain, given every existing row with that
 * hostname (hostnames are unique per company only, archived rows included).
 *
 *  - This integration's row → update it, wherever a human moved it. If it is
 *    archived, leave it: the operator stopped tracking it.
 *  - A synced row orphaned by a deleted integration (integrationId null) for
 *    the *same Cloudflare account*, in the configured company → reclaim it.
 *  - An active MANUAL row in the configured company → adopt it. Manual rows
 *    in other companies are never touched: the config was only authorised
 *    for the configured company.
 *  - Any other existing row (another integration's, an archived one, one in
 *    a different company) → skip rather than create a duplicate beside it.
 */
export function matchRow(
  rows: MonitoredDomain[],
  integrationId: string,
  accountId: string,
  companyId: string,
): RowMatch {
  const owned = rows.find((r) => r.integrationId === integrationId);
  if (owned) {
    return owned.archivedAt ? { kind: 'skip', reason: 'archived' } : { kind: 'update', row: owned };
  }
  // Orphans are reclaimed only inside the authorised company: an orphan in
  // another company belongs to whoever bound the deleted integration there.
  const orphan = rows.find(
    (r) =>
      r.source === 'CLOUDFLARE' &&
      r.integrationId === null &&
      r.cloudflareAccountId === accountId &&
      r.companyId === companyId &&
      !r.archivedAt,
  );
  if (orphan) return { kind: 'update', row: orphan };
  const manual = rows.find(
    (r) => r.source === 'MANUAL' && r.companyId === companyId && !r.archivedAt,
  );
  if (manual) return { kind: 'adopt', row: manual };
  if (rows.length === 0) return { kind: 'create' };
  const r = rows[0]!;
  return {
    kind: 'skip',
    reason: r.archivedAt
      ? 'archived'
      : r.source === 'CLOUDFLARE'
        ? 'owned by another Cloudflare integration'
        : 'exists in another company',
  };
}
