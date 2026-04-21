import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CheckResult,
  type DomainStatus,
  type MonitoredDomain,
  type Prisma,
  type DomainCheck as DomainCheckRow,
} from '@prisma/client';
import {
  domainHostnameSchema,
  type CreateMonitoredDomainInput,
  type DomainCheckDetails,
  type UpdateMonitoredDomainInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type {
  DomainCheckResult,
  SubCheckResult,
  WhoisSubResult,
  DnsSubResult,
  TlsSubResult,
} from './engine/index.js';

/**
 * Phase 8 — DomainsService.
 *
 * Responsibilities
 *   1. CRUD for `monitored_domains`.
 *   2. Hostname normalisation + uniqueness inside (companyId, active-rows).
 *   3. Archive / restore soft-delete idiom shared with articles & assets.
 *   4. Client-visibility filter: CLIENT_USER callers only see rows where
 *      `visibleToClients = true`. This is enforced inside the service so
 *      the list + detail endpoints can't forget it.
 *   5. Persistence of engine results: `persistCheckResult()` writes a new
 *      `domain_checks` row and denormalises lastCheckedAt/expiries/status
 *      back onto the parent row.
 */

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

export interface SerializedMonitoredDomain {
  id: string;
  companyId: string;
  hostname: string;
  checkWhois: boolean;
  checkDns: boolean;
  checkTls: boolean;
  alertThresholdDays: number;
  visibleToClients: boolean;
  lastCheckedAt: Date | null;
  whoisExpiresAt: Date | null;
  tlsExpiresAt: Date | null;
  latestStatus: DomainStatus;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializedDomainCheck {
  id: string;
  monitoredDomainId: string;
  companyId: string;
  checkedAt: Date;
  whoisStatus: CheckResult | null;
  dnsStatus: CheckResult | null;
  tlsStatus: CheckResult | null;
  whoisExpiresAt: Date | null;
  tlsExpiresAt: Date | null;
  details: DomainCheckDetails;
  error: string | null;
}

export interface DomainListOptions {
  includeArchived?: boolean;
  status?: DomainStatus;
  q?: string;
  limit?: number;
  cursor?: string;
}

@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async list(
    actor: AuthedUser,
    companyId: string,
    options: DomainListOptions = {},
  ): Promise<{ items: SerializedMonitoredDomain[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where: Prisma.MonitoredDomainWhereInput = { companyId };
    if (!options.includeArchived) where.archivedAt = null;
    if (options.status) where.latestStatus = options.status;
    if (options.q) where.hostname = { contains: options.q, mode: 'insensitive' };
    if (actor.role === 'CLIENT_USER') where.visibleToClients = true;

    const rows = await this.prisma.monitoredDomain.findMany({
      where,
      orderBy: [{ archivedAt: 'asc' }, { hostname: 'asc' }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map((r) => this.serialize(r)),
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  async getById(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<SerializedMonitoredDomain> {
    const row = await this.prisma.monitoredDomain.findFirst({
      where: { id, companyId },
    });
    if (!row) throw new NotFoundException();
    if (actor.role === 'CLIENT_USER' && !row.visibleToClients) {
      throw new NotFoundException();
    }
    return this.serialize(row);
  }

  async listChecks(
    actor: AuthedUser,
    companyId: string,
    domainId: string,
    limit = 30,
  ): Promise<SerializedDomainCheck[]> {
    // Ensure domain visibility before returning history.
    await this.getById(actor, companyId, domainId);
    const safe = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.domainCheck.findMany({
      where: { monitoredDomainId: domainId, companyId },
      orderBy: { checkedAt: 'desc' },
      take: safe,
    });
    return rows.map((r) => this.serializeCheck(r));
  }

  /**
   * Cross-company alerts feed, consumed by the global admin dashboard.
   * Never exposed to CLIENT_USER callers (the controller guards that).
   * Returns domains in EXPIRING or EXPIRED status, newest problem first.
   */
  async listAlertsAcrossCompanies(limit = 50): Promise<
    Array<{
      companyId: string;
      companyName: string;
      companySlug: string;
      domainId: string;
      hostname: string;
      status: DomainStatus;
      visibleToClients: boolean;
      whoisExpiresAt: Date | null;
      tlsExpiresAt: Date | null;
    }>
  > {
    const safe = Math.min(Math.max(limit, 1), 500);
    const rows = await this.prisma.monitoredDomain.findMany({
      where: {
        archivedAt: null,
        latestStatus: { in: ['EXPIRING', 'EXPIRED', 'FAIL'] },
      },
      include: {
        // Shallow company snapshot keeps the payload small.
        // We can't use Prisma include typing without another query, so
        // we denormalise inside a second batch read below. For now
        // return only the fields we have, then hydrate names.
      },
      orderBy: [{ latestStatus: 'asc' }, { hostname: 'asc' }],
      take: safe,
    });

    if (rows.length === 0) return [];

    const companies = await this.prisma.company.findMany({
      where: { id: { in: Array.from(new Set(rows.map((r) => r.companyId))) } },
      select: { id: true, name: true, slug: true },
    });
    const byId = new Map(companies.map((c) => [c.id, c] as const));

    return rows.map((r) => ({
      companyId: r.companyId,
      companyName: byId.get(r.companyId)?.name ?? 'Unknown',
      companySlug: byId.get(r.companyId)?.slug ?? 'unknown',
      domainId: r.id,
      hostname: r.hostname,
      status: r.latestStatus,
      visibleToClients: r.visibleToClients,
      whoisExpiresAt: r.whoisExpiresAt,
      tlsExpiresAt: r.tlsExpiresAt,
    }));
  }

  // ------------------------------------------------------------------
  // Write — CRUD
  // ------------------------------------------------------------------

  async create(
    actor: AuthedUser,
    companyId: string,
    input: CreateMonitoredDomainInput,
    meta: AuditMeta,
  ): Promise<SerializedMonitoredDomain> {
    // The controller already validates + normalises via the zod schema,
    // but we run it again here as a defence-in-depth so direct callers
    // (CLI, tests, future RPC) can't skip normalisation.
    const hostname = domainHostnameSchema.parse(input.hostname);
    await this.assertHostnameFree(companyId, hostname, null);

    // At least one sub-check must be enabled, otherwise we'd persist
    // rows that never get exercised — almost certainly user error.
    const flags = {
      checkWhois: input.checkWhois ?? true,
      checkDns: input.checkDns ?? true,
      checkTls: input.checkTls ?? true,
    };
    if (!flags.checkWhois && !flags.checkDns && !flags.checkTls) {
      throw new BadRequestException({
        error: 'NoSubChecksEnabled',
        message: 'Enable at least one of WHOIS, DNS, or TLS.',
      });
    }

    const created = await this.prisma.monitoredDomain.create({
      data: {
        companyId,
        hostname,
        checkWhois: flags.checkWhois,
        checkDns: flags.checkDns,
        checkTls: flags.checkTls,
        alertThresholdDays: input.alertThresholdDays ?? 30,
        visibleToClients: input.visibleToClients ?? false,
        createdBy: actor.id,
      },
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.domain.create,
      entityType: 'MonitoredDomain',
      entityId: created.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        hostname: created.hostname,
        checkWhois: created.checkWhois,
        checkDns: created.checkDns,
        checkTls: created.checkTls,
        alertThresholdDays: created.alertThresholdDays,
        visibleToClients: created.visibleToClients,
      },
    });
    return this.serialize(created);
  }

  async update(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdateMonitoredDomainInput,
    meta: AuditMeta,
  ): Promise<SerializedMonitoredDomain> {
    const existing = await this.prisma.monitoredDomain.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) {
      throw new BadRequestException(
        'Cannot edit an archived domain — restore it first.',
      );
    }

    const data: Prisma.MonitoredDomainUncheckedUpdateManyInput = {};
    if (input.hostname !== undefined) {
      const normalised = domainHostnameSchema.parse(input.hostname);
      if (normalised !== existing.hostname) {
        await this.assertHostnameFree(companyId, normalised, id);
      }
      data.hostname = normalised;
    }
    if (input.checkWhois !== undefined) data.checkWhois = input.checkWhois;
    if (input.checkDns !== undefined) data.checkDns = input.checkDns;
    if (input.checkTls !== undefined) data.checkTls = input.checkTls;
    if (input.alertThresholdDays !== undefined) {
      data.alertThresholdDays = input.alertThresholdDays;
    }
    if (input.visibleToClients !== undefined) {
      data.visibleToClients = input.visibleToClients;
    }

    const nextFlags = {
      checkWhois: (data.checkWhois as boolean | undefined) ?? existing.checkWhois,
      checkDns: (data.checkDns as boolean | undefined) ?? existing.checkDns,
      checkTls: (data.checkTls as boolean | undefined) ?? existing.checkTls,
    };
    if (!nextFlags.checkWhois && !nextFlags.checkDns && !nextFlags.checkTls) {
      throw new BadRequestException({
        error: 'NoSubChecksEnabled',
        message: 'Enable at least one of WHOIS, DNS, or TLS.',
      });
    }

    await this.prisma.monitoredDomain.updateMany({
      where: { id, companyId },
      data,
    });
    const updated = await this.prisma.monitoredDomain.findFirstOrThrow({
      where: { id, companyId },
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.domain.update,
      entityType: 'MonitoredDomain',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        hostname: existing.hostname,
        checkWhois: existing.checkWhois,
        checkDns: existing.checkDns,
        checkTls: existing.checkTls,
        alertThresholdDays: existing.alertThresholdDays,
        visibleToClients: existing.visibleToClients,
      },
      after: {
        hostname: updated.hostname,
        checkWhois: updated.checkWhois,
        checkDns: updated.checkDns,
        checkTls: updated.checkTls,
        alertThresholdDays: updated.alertThresholdDays,
        visibleToClients: updated.visibleToClients,
      },
    });
    return this.serialize(updated);
  }

  async archive(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedMonitoredDomain> {
    const existing = await this.prisma.monitoredDomain.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) throw new BadRequestException('Already archived');

    await this.prisma.monitoredDomain.updateMany({
      where: { id, companyId },
      data: { archivedAt: new Date() },
    });
    const updated = await this.prisma.monitoredDomain.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.domain.archive,
      entityType: 'MonitoredDomain',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null },
      after: { archivedAt: updated.archivedAt },
    });
    return this.serialize(updated);
  }

  async restore(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedMonitoredDomain> {
    const existing = await this.prisma.monitoredDomain.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (!existing.archivedAt) throw new BadRequestException('Not archived');

    await this.assertHostnameFree(companyId, existing.hostname, id);
    await this.prisma.monitoredDomain.updateMany({
      where: { id, companyId },
      data: { archivedAt: null },
    });
    const updated = await this.prisma.monitoredDomain.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.domain.restore,
      entityType: 'MonitoredDomain',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: existing.archivedAt },
      after: { archivedAt: null },
    });
    return this.serialize(updated);
  }

  // ------------------------------------------------------------------
  // Persistence of engine results
  // ------------------------------------------------------------------

  /**
   * Writes a `domain_checks` row and denormalises the summary back onto
   * the parent `monitored_domain`. Called from the BullMQ processor
   * (shared business logic) so both scheduled and ad-hoc "check now"
   * runs produce identical state.
   *
   * Transactional so we never end up with a check row + stale parent.
   */
  async persistCheckResult(args: {
    domainId: string;
    companyId: string;
    result: DomainCheckResult;
    status: DomainStatus;
    actorId: string | null;
    reason: 'scheduled' | 'manual';
    meta: AuditMeta;
  }): Promise<SerializedDomainCheck> {
    const {
      domainId,
      companyId,
      result,
      status,
      actorId,
      reason,
      meta,
    } = args;

    const checkData: Prisma.DomainCheckUncheckedCreateInput = {
      monitoredDomainId: domainId,
      companyId,
      checkedAt: result.checkedAt,
      whoisStatus: result.whois.status,
      dnsStatus: result.dns.status,
      tlsStatus: result.tls.status,
      whoisExpiresAt: safeDate((result.whois as SubCheckResult<WhoisSubResult>).data?.expiresAt),
      tlsExpiresAt: safeDate((result.tls as SubCheckResult<TlsSubResult>).data?.validTo),
      details: result.details as unknown as Prisma.InputJsonValue,
      error: result.aggregateError,
    };

    const stored = await this.prisma.$transaction(async (tx) => {
      const created = await tx.domainCheck.create({ data: checkData });
      await tx.monitoredDomain.updateMany({
        where: { id: domainId, companyId },
        data: {
          lastCheckedAt: result.checkedAt,
          whoisExpiresAt: checkData.whoisExpiresAt ?? null,
          tlsExpiresAt: checkData.tlsExpiresAt ?? null,
          latestStatus: status,
        },
      });
      return created;
    });

    // Manual runs are actor-driven writes and must be auditable. We
    // deliberately skip the log for scheduled runs to avoid flooding
    // the audit table with one row per domain per day.
    if (reason === 'manual') {
      await this.audit.log({
        actorId,
        action: AUDIT_ACTIONS.domain.check,
        entityType: 'MonitoredDomain',
        entityId: domainId,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          status,
          whoisStatus: result.whois.status,
          dnsStatus: result.dns.status,
          tlsStatus: result.tls.status,
        },
      });
    }

    // Touch unused typings to keep the compiler honest.
    const _dns: SubCheckResult<DnsSubResult> = result.dns;
    void _dns;

    return this.serializeCheck(stored);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async assertHostnameFree(
    companyId: string,
    hostname: string,
    excludeId: string | null,
  ): Promise<void> {
    // Matches the partial unique index on `monitored_domains`:
    // `(company_id, hostname) WHERE archived_at IS NULL`. We filter by
    // the same predicate so the race window between check and insert
    // is one RTT — the DB index is the final authority.
    const clash = await this.prisma.monitoredDomain.findFirst({
      where: {
        companyId,
        hostname,
        archivedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        error: 'HostnameTaken',
        hostname,
        message: `This company already monitors "${hostname}".`,
      });
    }
  }

  private serialize(row: MonitoredDomain): SerializedMonitoredDomain {
    return {
      id: row.id,
      companyId: row.companyId,
      hostname: row.hostname,
      checkWhois: row.checkWhois,
      checkDns: row.checkDns,
      checkTls: row.checkTls,
      alertThresholdDays: row.alertThresholdDays,
      visibleToClients: row.visibleToClients,
      lastCheckedAt: row.lastCheckedAt,
      whoisExpiresAt: row.whoisExpiresAt,
      tlsExpiresAt: row.tlsExpiresAt,
      latestStatus: row.latestStatus,
      archivedAt: row.archivedAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private serializeCheck(row: DomainCheckRow): SerializedDomainCheck {
    return {
      id: row.id,
      monitoredDomainId: row.monitoredDomainId,
      companyId: row.companyId,
      checkedAt: row.checkedAt,
      whoisStatus: row.whoisStatus,
      dnsStatus: row.dnsStatus,
      tlsStatus: row.tlsStatus,
      whoisExpiresAt: row.whoisExpiresAt,
      tlsExpiresAt: row.tlsExpiresAt,
      details: (row.details ?? {}) as DomainCheckDetails,
      error: row.error,
    };
  }
}

function safeDate(d: Date | null | undefined): Date | null {
  if (!d) return null;
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
