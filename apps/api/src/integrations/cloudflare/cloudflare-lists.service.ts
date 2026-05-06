import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type CloudflareIpList as CloudflareIpListRow } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  parseIpEntry,
  type CloudflareDriftDetailsDto,
  type CloudflareDriftStatusValue,
  type CloudflareEntryInput,
  type CloudflareExternalListDto,
  type CloudflareIpEntryDto,
  type CloudflareIpListDto,
  type CloudflarePushResponse,
} from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import { IntegrationsService, type AuditMeta } from '../integrations.service.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import type { CloudflareDriver } from '../drivers/cloudflare/cloudflare.driver.js';
import type { CloudflareListItem } from '../drivers/cloudflare/cloudflare-api.client.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

/**
 * Per-entry storage shape inside `CloudflareIpList.entries` (JSON array).
 *
 * Cloudflare Gateway list items are addressed by their string value
 * (no per-item id), so we don't track an external item id locally —
 * drift detection compares canonicalised IP values directly.
 */
interface StoredEntry {
  ip: string;
  description: string;
}

@Injectable()
export class CloudflareListsService {
  private readonly logger = new Logger(CloudflareListsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
  ) {}

  // -------------------------------------------------------------------
  // Public API consumed by the controller and worker
  // -------------------------------------------------------------------

  async listExternalLists(
    integrationId: string,
  ): Promise<CloudflareExternalListDto[]> {
    const { driver, ctx } = await this.loadDriver(integrationId);
    const lists = await driver.listExternalLists(
      ctx.config,
      ctx.secret,
      this.httpDefaults(),
      randomUUID(),
    );
    const registered = await this.prisma.cloudflareIpList.findMany({
      where: { integrationId },
      select: { externalListId: true },
    });
    const registeredIds = new Set(registered.map((r) => r.externalListId));
    return lists.map((l) => ({
      externalListId: l.externalListId,
      name: l.name,
      description: l.description,
      numItems: l.numItems,
      kind: l.kind,
      alreadyRegistered: registeredIds.has(l.externalListId),
    }));
  }

  async listRegisteredLists(integrationId: string): Promise<CloudflareIpListDto[]> {
    const rows = await this.prisma.cloudflareIpList.findMany({
      where: { integrationId },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async getRegisteredList(
    integrationId: string,
    listId: string,
  ): Promise<CloudflareIpListDto> {
    const row = await this.requireList(integrationId, listId);
    return this.toDto(row);
  }

  async registerList(
    actor: AuthedUser,
    integrationId: string,
    externalListId: string,
    meta: AuditMeta,
  ): Promise<CloudflareIpListDto> {
    const { driver, ctx, accountId } = await this.loadDriver(integrationId);
    const correlationId = randomUUID();
    const lists = await driver.listExternalLists(
      ctx.config,
      ctx.secret,
      this.httpDefaults(),
      correlationId,
    );
    const remote = lists.find((l) => l.externalListId === externalListId);
    if (!remote) {
      throw new NotFoundException(
        `Cloudflare list "${externalListId}" not found in this account.`,
      );
    }
    if (remote.kind !== 'ip') {
      throw new BadRequestException(
        `Cloudflare list "${remote.name}" is of kind "${remote.kind}" — only IP lists can be registered.`,
      );
    }
    const existing = await this.prisma.cloudflareIpList.findUnique({
      where: {
        integrationId_externalListId: {
          integrationId,
          externalListId,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        `List "${remote.name}" is already registered to this integration.`,
      );
    }
    const items = await driver.listExternalListItems(
      ctx.config,
      ctx.secret,
      externalListId,
      this.httpDefaults(),
      correlationId,
    );
    const seedEntries: StoredEntry[] = items.map((i) =>
      this.canonicaliseStoredEntry({ ip: i.ip, description: '' }),
    );

    const created = await this.prisma.cloudflareIpList.create({
      data: {
        integrationId,
        externalAccountId: accountId,
        externalListId,
        name: remote.name,
        description: remote.description ?? null,
        entries: seedEntries as unknown as Prisma.InputJsonValue,
        entriesVersion: 1,
        driftStatus: 'in_sync',
        lastDriftCheckAt: new Date(),
      },
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.cloudflareListRegister,
      entityType: 'CloudflareIpList',
      entityId: created.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        integrationId,
        externalListId,
        name: remote.name,
        seededEntries: seedEntries.length,
      },
    });

    return this.toDto(created);
  }

  async unregisterList(
    actor: AuthedUser,
    integrationId: string,
    listId: string,
    meta: AuditMeta,
  ): Promise<void> {
    const row = await this.requireList(integrationId, listId);
    await this.prisma.cloudflareIpList.delete({ where: { id: listId } });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.cloudflareListUnregister,
      entityType: 'CloudflareIpList',
      entityId: listId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { name: row.name, externalListId: row.externalListId },
      after: null,
    });
  }

  async addEntry(
    actor: AuthedUser,
    integrationId: string,
    listId: string,
    input: CloudflareEntryInput,
    entriesVersion: number,
    meta: AuditMeta,
  ): Promise<CloudflarePushResponse> {
    return this.mutateAndPush(actor, integrationId, listId, entriesVersion, meta, {
      kind: 'add',
      input,
    });
  }

  async updateEntry(
    actor: AuthedUser,
    integrationId: string,
    listId: string,
    entryKey: string,
    input: CloudflareEntryInput,
    entriesVersion: number,
    meta: AuditMeta,
  ): Promise<CloudflarePushResponse> {
    return this.mutateAndPush(actor, integrationId, listId, entriesVersion, meta, {
      kind: 'update',
      entryKey,
      input,
    });
  }

  async removeEntry(
    actor: AuthedUser,
    integrationId: string,
    listId: string,
    entryKey: string,
    entriesVersion: number,
    meta: AuditMeta,
  ): Promise<CloudflarePushResponse> {
    return this.mutateAndPush(actor, integrationId, listId, entriesVersion, meta, {
      kind: 'remove',
      entryKey,
    });
  }

  async overwriteCloudflare(
    actor: AuthedUser,
    integrationId: string,
    listId: string,
    entriesVersion: number,
    meta: AuditMeta,
  ): Promise<CloudflarePushResponse> {
    return this.mutateAndPush(actor, integrationId, listId, entriesVersion, meta, {
      kind: 'overwrite',
    });
  }

  // -------------------------------------------------------------------
  // Drift check (also called by the worker drift-sweep processor)
  // -------------------------------------------------------------------

  async runDriftCheck(
    integrationId: string,
    listId: string,
    actor: AuthedUser | null,
    meta: AuditMeta | null,
  ): Promise<CloudflareIpListDto> {
    const row = await this.requireList(integrationId, listId);
    const { driver, ctx } = await this.loadDriver(integrationId);
    const correlationId = randomUUID();

    let cfItems: CloudflareListItem[];
    try {
      cfItems = await driver.listExternalListItems(
        ctx.config,
        ctx.secret,
        row.externalListId,
        this.httpDefaults(),
        correlationId,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const updated = await this.prisma.cloudflareIpList.update({
        where: { id: listId },
        data: {
          driftStatus: 'error',
          lastDriftCheckAt: new Date(),
          driftDetails: {
            missingOnCf: [],
            extraOnCf: [],
            lastError: message.slice(0, 500),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return this.toDto(updated);
    }

    const fresh = await this.prisma.cloudflareIpList.findUnique({
      where: { id: listId },
    });
    const local = fresh ? readEntries(fresh.entries) : [];
    const diff = computeDrift(local, cfItems);

    const status: CloudflareDriftStatusValue =
      diff.missingOnCf.length === 0 && diff.extraOnCf.length === 0
        ? 'in_sync'
        : 'drift_detected';

    const updated = await this.prisma.cloudflareIpList.update({
      where: { id: listId },
      data: {
        driftStatus: status,
        lastDriftCheckAt: new Date(),
        driftDetails: {
          missingOnCf: diff.missingOnCf,
          extraOnCf: diff.extraOnCf,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    if (actor && meta) {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.cloudflareDriftCheck,
        entityType: 'CloudflareIpList',
        entityId: listId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          status,
          missingOnCf: diff.missingOnCf.length,
          extraOnCf: diff.extraOnCf.length,
        },
      });
    }
    return this.toDto(updated);
  }

  /** Worker entrypoint: run drift check for every list under one integration. */
  async runDriftSweep(integrationId: string): Promise<void> {
    const lists = await this.prisma.cloudflareIpList.findMany({
      where: { integrationId },
      select: { id: true },
    });
    for (const l of lists) {
      try {
        await this.runDriftCheck(integrationId, l.id, null, null);
      } catch (e) {
        this.logger.error(
          { err: (e as Error).message, listId: l.id },
          'drift check failed',
        );
      }
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async mutateAndPush(
    actor: AuthedUser,
    integrationId: string,
    listId: string,
    entriesVersion: number,
    meta: AuditMeta,
    op:
      | { kind: 'add'; input: CloudflareEntryInput }
      | { kind: 'update'; entryKey: string; input: CloudflareEntryInput }
      | { kind: 'remove'; entryKey: string }
      | { kind: 'overwrite' },
  ): Promise<CloudflarePushResponse> {
    const row = await this.requireList(integrationId, listId);
    if (row.entriesVersion !== entriesVersion) {
      throw new ConflictException(
        'List was changed elsewhere — reload and retry.',
      );
    }

    const current = readEntries(row.entries);
    let next: StoredEntry[];
    let auditAction: string;
    let auditAfter: Record<string, unknown> = {};

    if (op.kind === 'overwrite') {
      next = current.slice();
      auditAction = AUDIT_ACTIONS.integration.cloudflareOverwrite;
      auditAfter = { entries: next.length };
    } else if (op.kind === 'add') {
      const incoming = this.canonicaliseStoredEntry({
        ip: op.input.ip,
        description: op.input.description ?? '',
      });
      if (current.some((e) => e.ip === incoming.ip)) {
        throw new ConflictException(
          `Entry "${incoming.ip}" already exists in this list.`,
        );
      }
      next = [...current, incoming];
      auditAction = AUDIT_ACTIONS.integration.cloudflareEntryAdd;
      auditAfter = { ip: incoming.ip, description: incoming.description };
    } else if (op.kind === 'update') {
      const idx = current.findIndex((e) => e.ip === op.entryKey);
      if (idx < 0) throw new NotFoundException(`Entry "${op.entryKey}" not found.`);
      const updated = this.canonicaliseStoredEntry({
        ip: op.input.ip,
        description: op.input.description ?? '',
      });
      next = current.map((e, i) => (i === idx ? updated : e));
      auditAction = AUDIT_ACTIONS.integration.cloudflareEntryUpdate;
      auditAfter = {
        before: { ip: current[idx]!.ip, description: current[idx]!.description },
        after: { ip: updated.ip, description: updated.description },
      };
    } else {
      const idx = current.findIndex((e) => e.ip === op.entryKey);
      if (idx < 0) throw new NotFoundException(`Entry "${op.entryKey}" not found.`);
      next = current.filter((_, i) => i !== idx);
      auditAction = AUDIT_ACTIONS.integration.cloudflareEntryRemove;
      auditAfter = { ip: current[idx]!.ip };
    }

    const { driver, ctx } = await this.loadDriverFor(integrationId);
    const correlationId = randomUUID();
    let pushedItems: CloudflareListItem[];
    try {
      const result = await driver.syncListItems(
        ctx.config,
        ctx.secret,
        row.externalListId,
        next.map((e) => ({ ip: e.ip })),
        this.httpDefaults(),
        correlationId,
      );
      pushedItems = result.items;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(
        `Cloudflare push failed: ${message.slice(0, 500)}`,
      );
    }

    // Reconcile: trust Cloudflare's returned items as the source of
    // truth on what's actually persisted (handles any normalisation
    // differences). Each entry's description is preserved locally;
    // entries Cloudflare didn't accept are dropped.
    const cfIps = new Set(pushedItems.map((i) => normaliseIp(i.ip)));
    const reconciled = next.filter((e) => cfIps.has(normaliseIp(e.ip)));

    const updated = await this.prisma.cloudflareIpList.update({
      where: { id: listId },
      data: {
        entries: reconciled as unknown as Prisma.InputJsonValue,
        entriesVersion: row.entriesVersion + 1,
        lastPushedAt: new Date(),
        driftStatus: 'in_sync',
        lastDriftCheckAt: new Date(),
        driftDetails: {
          missingOnCf: [],
          extraOnCf: [],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      actorId: actor.id,
      action: auditAction,
      entityType: 'CloudflareIpList',
      entityId: listId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: auditAfter,
    });

    return { list: this.toDto(updated) };
  }

  private async loadDriver(integrationId: string): Promise<{
    driver: CloudflareDriver;
    ctx: { config: Record<string, unknown>; secret: Record<string, unknown> };
    accountId: string;
  }> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });
    if (!integration) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }
    if (
      !this.drivers.has(integration.driver) ||
      this.drivers.kindOf(integration.driver) !== 'security'
    ) {
      throw new BadRequestException(
        `Integration ${integrationId} is not a Cloudflare integration.`,
      );
    }
    const ctx = await this.integrations.loadDriverContext(integrationId);
    const driver = this.drivers.getSecurity(integration.driver);
    return {
      driver,
      ctx: { config: ctx.config, secret: ctx.secret },
      accountId: driver.parseAccountId(ctx.config),
    };
  }

  private async loadDriverFor(integrationId: string): Promise<{
    driver: CloudflareDriver;
    ctx: { config: Record<string, unknown>; secret: Record<string, unknown> };
  }> {
    const { driver, ctx } = await this.loadDriver(integrationId);
    return { driver, ctx };
  }

  private async requireList(integrationId: string, listId: string) {
    const row = await this.prisma.cloudflareIpList.findFirst({
      where: { id: listId, integrationId },
    });
    if (!row) throw new NotFoundException(`Cloudflare list ${listId} not found`);
    return row;
  }

  private canonicaliseStoredEntry(entry: StoredEntry): StoredEntry {
    const parsed = parseIpEntry(entry.ip);
    if (!parsed) {
      throw new BadRequestException(
        `"${entry.ip}" is not a valid IPv4/IPv6 address or CIDR.`,
      );
    }
    return {
      ip: parsed.canonical,
      description: (entry.description ?? '').trim(),
    };
  }

  private toDto(row: CloudflareIpListRow): CloudflareIpListDto {
    const entries: CloudflareIpEntryDto[] = readEntries(row.entries).map((e) => ({
      ip: e.ip,
      description: e.description,
    }));
    return {
      id: row.id,
      integrationId: row.integrationId,
      externalAccountId: row.externalAccountId,
      externalListId: row.externalListId,
      name: row.name,
      description: row.description,
      entries,
      entriesVersion: row.entriesVersion,
      driftStatus: row.driftStatus,
      driftDetails:
        row.driftDetails && typeof row.driftDetails === 'object'
          ? ((row.driftDetails as unknown) as CloudflareDriftDetailsDto)
          : null,
      lastDriftCheckAt: row.lastDriftCheckAt
        ? row.lastDriftCheckAt.toISOString()
        : null,
      lastPushedAt: row.lastPushedAt ? row.lastPushedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private httpDefaults() {
    return {
      timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
      maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
      backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
    };
  }
}

function readEntries(raw: unknown): StoredEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const ip = typeof r.ip === 'string' ? r.ip : null;
    if (!ip) continue;
    out.push({
      ip,
      description: typeof r.description === 'string' ? r.description : '',
    });
  }
  return out;
}

function normaliseIp(ip: string): string {
  const parsed = parseIpEntry(ip);
  return parsed ? parsed.canonical : ip.trim().toLowerCase();
}

function computeDrift(
  local: StoredEntry[],
  cfItems: CloudflareListItem[],
): { missingOnCf: string[]; extraOnCf: Array<{ ip: string; comment: string | null }> } {
  const localByIp = new Map(local.map((e) => [normaliseIp(e.ip), e]));
  const cfByIp = new Map(cfItems.map((i) => [normaliseIp(i.ip), i]));
  const missingOnCf: string[] = [];
  for (const [key, entry] of localByIp) {
    if (!cfByIp.has(key)) missingOnCf.push(entry.ip);
  }
  const extraOnCf: Array<{ ip: string; comment: string | null }> = [];
  for (const [key, item] of cfByIp) {
    if (!localByIp.has(key)) {
      extraOnCf.push({ ip: item.ip, comment: null });
    }
  }
  return { missingOnCf, extraOnCf };
}
