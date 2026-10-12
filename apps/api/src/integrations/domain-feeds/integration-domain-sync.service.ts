import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MonitoredDomain } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { domainHostnameSchema } from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import { QueuesService } from '../../queues/queues.service.js';
import { IntegrationsService } from '../integrations.service.js';
import { lockDomainHostname } from '../cloudflare/cloudflare-registrar-sync.service.js';
import { listWorkspaceDomains } from '../drivers/google-workspace/google-workspace.driver.js';
import { DriverAuthError, DriverRateLimitError, type IntegrationContext } from '../drivers/integration-driver.js';

export interface DomainSyncResult {
  created: number;
  matched: number;
  missing: number;
  skipped: number;
}

const WORKER_META = { ip: '0.0.0.0', userAgent: 'weavestream-worker/integration-sync' };

/**
 * One provider whose verified domains feed Domains monitoring. Each writes
 * only its own columns (`link`, `missing` and what `present` returns), so
 * feeds never overwrite each other or the Cloudflare registrar facts.
 */
interface DomainFeed {
  label: string;
  source: 'GOOGLE_WORKSPACE';
  auditAction: string;
  link: 'workspaceIntegrationId';
  missing: 'workspaceMissingSince';
  list(ctx: IntegrationContext, externalOrgId: string): Promise<Array<{ hostname: string } & Record<string, unknown>>>;
  /** Columns written on a row the domain is (still) in the provider. */
  present(integrationId: string, domain: never, now: Date): Prisma.MonitoredDomainUncheckedUpdateInput;
  /** Columns cleared when the domain left the provider (the missing stamp is added). */
  gone: Prisma.MonitoredDomainUncheckedUpdateInput;
}

const FEEDS: Readonly<Record<string, DomainFeed>> = {
  'google-workspace': {
    label: 'Google Workspace',
    source: 'GOOGLE_WORKSPACE',
    auditAction: AUDIT_ACTIONS.integration.googleWorkspaceDomainSync,
    link: 'workspaceIntegrationId',
    missing: 'workspaceMissingSince',
    list: (ctx, org) => listWorkspaceDomains(ctx, org) as never,
    present: (integrationId, d: { role: 'PRIMARY' | 'SECONDARY' | 'ALIAS'; aliasOf: string | null }, now) => ({
      workspaceIntegrationId: integrationId,
      workspaceRole: d.role,
      workspaceAliasOf: d.aliasOf,
      workspaceSyncedAt: now,
      workspaceMissingSince: null,
    }),
    gone: { workspaceRole: null, workspaceAliasOf: null },
  },
};

/** Drivers whose domains feed Domains monitoring. */
export function hasDomainFeed(driver: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEEDS, driver);
}

/**
 * Provider domains (Google Workspace) → Domains monitoring
 * (MonitoredDomain).
 *
 * Runs once per mapping sync, scoped to the mapping's company only. A
 * verified domain is matched to an existing row of that company by hostname
 * (manual, Cloudflare or another feed's); a match gains only that feed's
 * columns, so registrar facts, check settings and the row's source stay
 * with whoever owns them (Cloudflare wins). With no match a row with the
 * feed's source is created and its first check queued. Archived rows are
 * left alone and block creation, as for Cloudflare.
 *
 * Never deletes: a domain that leaves the provider has the feed's facts
 * cleared and its missing date stamped.
 */
@Injectable()
export class IntegrationDomainSyncService {
  private readonly logger = new Logger(IntegrationDomainSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
    private readonly queues: QueuesService,
  ) {}

  async syncMapping(mappingId: string, actorId: string | null): Promise<DomainSyncResult> {
    const mapping = await this.prisma.integrationCompanyMapping.findUnique({
      where: { id: mappingId },
      select: {
        id: true,
        companyId: true,
        externalOrgId: true,
        integrationId: true,
        integration: { select: { driver: true } },
        company: { select: { archivedAt: true } },
      },
    });
    const result: DomainSyncResult = { created: 0, matched: 0, missing: 0, skipped: 0 };
    const feed = mapping && hasDomainFeed(mapping.integration.driver) ? FEEDS[mapping.integration.driver] : undefined;
    if (!mapping || !feed || mapping.company.archivedAt) {
      return result;
    }
    const { companyId, integrationId } = mapping;

    // Only the connection of this mapping's own tenant.
    const loaded = await this.integrations.loadDriverContext(integrationId, { externalOrgId: mapping.externalOrgId });
    const domains = await feed.list(
      {
        config: loaded.config,
        secret: loaded.secret,
        oauthClient: loaded.oauthClient,
        connectionId: loaded.connectionId,
        credentialVersion: loaded.credentialVersion,
        integrationId,
        http: {
          timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
          maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
          backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
        },
        correlationId: randomUUID(),
      },
      mapping.externalOrgId,
    );

    const now = new Date();
    const seen = new Set<string>();
    const createdIds: string[] = [];
    const createdNames: string[] = [];
    const skipped: Record<string, string> = {};

    for (const domain of domains) {
      const parsed = domainHostnameSchema.safeParse(domain.hostname);
      if (!parsed.success) {
        this.logger.warn(`Skipping unparseable ${feed.label} domain (integration=${integrationId})`);
        continue;
      }
      const hostname = parsed.data;
      seen.add(hostname);
      const outcome = await this.writeDomain(feed, companyId, integrationId, hostname, feed.present(integrationId, domain as never, now), actorId);
      if (outcome.kind === 'match') result.matched += 1;
      else if (outcome.kind === 'skip') {
        result.skipped += 1;
        skipped[hostname] = outcome.reason;
      } else {
        result.created += 1;
        createdIds.push(outcome.id);
        createdNames.push(hostname);
      }
    }

    // Rows this integration linked in this company that the provider no
    // longer reports. Stamp once so the date records when it went missing.
    // shortcut: rows carry the integration, not the tenant, so a company
    // mapped to several tenants of one integration is never stamped (each
    // tenant would mark the other's domains missing); store the connection
    // on the row if that case needs missing detection.
    const otherTenants = await this.prisma.integrationCompanyMapping.count({
      where: { integrationId, companyId, id: { not: mapping.id } },
    });
    const linked = otherTenants > 0 ? [] : await this.prisma.monitoredDomain.findMany({
      where: { companyId, [feed.link]: integrationId, archivedAt: null, [feed.missing]: null },
      select: { id: true, hostname: true },
    });
    const gone = linked.filter((r) => !seen.has(r.hostname.toLowerCase()));
    if (gone.length > 0) {
      await this.prisma.monitoredDomain.updateMany({
        where: { id: { in: gone.map((r) => r.id) }, companyId },
        data: { ...feed.gone, [feed.missing]: now },
      });
      result.missing = gone.length;
    }

    // First WHOIS/DNS/TLS check now, like a manual add. Best effort.
    for (const domainId of createdIds) {
      await this.queues
        .enqueueDomainCheck({ kind: 'single', domainId, actorId })
        .catch((err: unknown) =>
          this.logger.warn(
            `First check for ${feed.label} domain ${domainId} not queued: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    await this.audit.log({
      actorId,
      action: feed.auditAction,
      entityType: 'IntegrationCompanyMapping',
      entityId: mapping.id,
      companyId,
      ip: WORKER_META.ip,
      userAgent: WORKER_META.userAgent,
      before: null,
      after: {
        ...result,
        seen: seen.size,
        skipped,
        createdHostnames: createdNames,
        missingHostnames: gone.map((r) => r.hostname),
      },
    });
    return result;
  }

  private async writeDomain(
    feed: DomainFeed,
    companyId: string,
    integrationId: string,
    hostname: string,
    columns: Prisma.MonitoredDomainUncheckedUpdateInput,
    actorId: string | null,
  ): Promise<WriteOutcome> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<WriteOutcome> => {
        // Same lock as the Cloudflare sync: neither can create beside the other.
        await lockDomainHostname(tx, hostname);
        const candidates = await tx.monitoredDomain.findMany({
          where: { companyId, hostname: { equals: hostname, mode: 'insensitive' } },
        });
        const match = matchDomainRow(candidates);
        if (match.kind === 'match') {
          await tx.monitoredDomain.updateMany({ where: { id: match.row.id, companyId }, data: columns });
          return { kind: 'match' };
        }
        if (match.kind === 'skip') return match;
        const row = await tx.monitoredDomain.create({
          data: {
            ...(columns as Prisma.MonitoredDomainUncheckedCreateInput),
            companyId,
            hostname,
            source: feed.source,
            integrationId,
            createdBy: actorId,
          },
          select: { id: true },
        });
        return { kind: 'create', id: row.id };
      });
    } catch (err) {
      // Added by hand mid-run (manual adds do not take the lock); the unique
      // index refused the duplicate. The next sync matches it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(`Skipping ${hostname}: created concurrently (integration=${integrationId})`);
        return { kind: 'skip', reason: 'created concurrently' };
      }
      throw err;
    }
  }
}

type WriteOutcome = { kind: 'match' } | { kind: 'skip'; reason: string } | { kind: 'create'; id: string };

/**
 * Given every row of the mapped company with this hostname: the active row
 * is matched (whatever its source); only archived rows → skip, so an
 * operator's archive is neither undone nor shadowed by a new row; none →
 * create.
 */
export function matchDomainRow(
  rows: MonitoredDomain[],
): { kind: 'match'; row: MonitoredDomain } | { kind: 'skip'; reason: string } | { kind: 'create' } {
  const active = rows.find((r) => !r.archivedAt);
  if (active) return { kind: 'match', row: active };
  if (rows.length > 0) return { kind: 'skip', reason: 'archived' };
  return { kind: 'create' };
}

/**
 * Run-warning text for a failed domain sync. Driver errors carry fixed,
 * operator-safe text (missing privilege, rate limit, wrong tenant); anything
 * else may hold internal detail and gets a generic line (full error in the
 * worker log).
 */
export function domainSyncWarning(err: unknown, driver: string): string {
  const known = err instanceof DriverAuthError || err instanceof DriverRateLimitError;
  const detail = known ? (err as Error).message : 'an internal error occurred (see the worker log)';
  return `${FEEDS[driver]?.label ?? 'Provider'} domains were not synced to Domains monitoring: ${detail}`;
}
