import {
  BadRequestException,
  ConflictException,
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
import { CloudflareDriftSweepJobNames, QueueNames } from '@weavestream/shared';
import { IntegrationsService } from '../integrations.service.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import { cloudflareConfigSchema } from '../drivers/cloudflare/cloudflare.driver.js';

/**
 * Lease covers the listing phase (~one Cloudflare request per domain, which
 * may wait out 429 Retry-After). After listing the lease is renewed to
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

export interface RegistrarSyncResult {
  /** False when no domains company is configured (sync off). */
  enabled: boolean;
  created: number;
  updated: number;
  /** MANUAL rows that matched a Cloudflare domain and were taken over. */
  adopted: number;
  /** Rows this integration owns that Cloudflare no longer reports. */
  missing: number;
}

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
   * would refuse for anyone short of full global access. The fixed job id
   * collapses repeat clicks while one is queued or running; failed jobs are
   * removed at once, or BullMQ would silently ignore every later click.
   */
  async enqueue(integrationId: string, actorId: string): Promise<{ queued: true }> {
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
    // A queued job that then hits the lock would fail with nobody watching.
    // Say so now instead. (A sweep could still start in between; that run
    // does the same work, so the click is not lost in substance.)
    if (await this.redis.client.exists(lockKey(integrationId))) {
      throw new ConflictException('A domain sync for this integration is already running.');
    }
    await this.queues.get(QueueNames.cloudflareDriftSweep).add(
      CloudflareDriftSweepJobNames.manual,
      { integrationId, triggeredBy: actorId },
      { jobId: `manual-domains-${integrationId}`, removeOnComplete: true, removeOnFail: true },
    );
    return { queued: true };
  }

  async sync(
    integrationId: string,
    actorId: string | null,
    meta: { ip: string; userAgent: string } = { ip: 'worker', userAgent: 'worker' },
  ): Promise<RegistrarSyncResult> {
    // One run per integration at a time: a manual sync overlapping the
    // scheduled sweep would otherwise race on the find-then-create below.
    const key = lockKey(integrationId);
    const token = randomUUID();
    const got = await this.redis.client.set(key, token, 'EX', LISTING_LEASE_SEC, 'NX');
    if (got !== 'OK') {
      throw new ConflictException('A domain sync for this integration is already running.');
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
        throw new Error(`Registrar sync lost its lock while listing (integration=${integrationId})`);
      }
      return Date.now() + WRITE_DEADLINE_MS;
    };
    try {
      return await this.run(integrationId, actorId, meta, startWrites);
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

  private async run(
    integrationId: string,
    actorId: string | null,
    meta: { ip: string; userAgent: string },
    startWrites: () => Promise<number>,
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
      randomUUID(),
    );
    const deadline = await startWrites();

    const now = new Date();
    const seen = new Set<string>();
    const createdNames: string[] = [];
    const adoptedNames: string[] = [];
    const skipped: Record<string, string> = {};

    // Checked immediately before every write: past the deadline the lock may
    // lapse, so stop rather than race a new run. Rows not reached are left
    // untouched for the next sweep, and nothing is stamped missing because
    // `seen` is incomplete.
    const assertBudget = () => {
      if (Date.now() > deadline) {
        throw new Error(`Registrar sync exceeded its time budget (integration=${integrationId})`);
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

      // Archived rows included: an archive is an operator's decision and
      // must not be undone by recreating the domain next to it.
      const candidates = await this.prisma.monitoredDomain.findMany({ where: { hostname } });
      const match = matchRow(candidates, integrationId, config.accountId, company.id);

      if (match.kind === 'update' || match.kind === 'adopt') {
        assertBudget();
        await this.prisma.monitoredDomain.update({
          where: { id: match.row.id },
          data: registrarData,
        });
        if (match.kind === 'adopt') {
          result.adopted += 1;
          adoptedNames.push(hostname);
        } else {
          result.updated += 1;
        }
      } else if (match.kind === 'skip') {
        skipped[hostname] = match.reason;
      } else {
        try {
          assertBudget();
          await this.prisma.monitoredDomain.create({
            data: {
              ...registrarData,
              companyId: company.id,
              hostname,
              createdBy: actorId,
            },
          });
          result.created += 1;
          createdNames.push(hostname);
        } catch (err) {
          // Someone added the same hostname by hand mid-run. Leave it; the
          // next sweep adopts it through matchRow.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
            throw err;
          }
          this.logger.warn(`Skipping ${hostname}: created concurrently (integration=${integrationId})`);
        }
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
