import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  INTEGRATION_DIFFERENCES_BULK_MAX,
  type IntegrationDifferenceBulkMiss,
  type IntegrationDifferenceRowDto,
  type IntegrationDifferencesBulkResult,
  type IntegrationDifferencesPage,
  type IntegrationDifferencesQuery,
  type ResolveIntegrationDifferenceInput,
  type ResolveIntegrationDifferencesBulkInput,
} from '@weavestream/shared';
import { getTenantContext, runWithTenantContext } from '@weavestream/shared/server';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { AssetsService } from '../assets/assets.service.js';
import type { AuditMeta } from './integrations.service.js';
import { IntegrationProvenanceService } from './reconstruction/integration-provenance.service.js';
import { PermissionService } from '../rbac/permission.service.js';
import { differenceDisplayValue, parseFieldDiffs, parseFieldResolutions } from './field-diffs.js';

/** Rows with any open difference (the column defaults to `{}`). */
const HAS_DIFFS: Prisma.IntegrationSyncRecordWhereInput = { NOT: { fieldDiffs: { equals: {} } } };

interface BulkTarget {
  syncRecordId: string;
  assetFieldId: string;
  companyId: string;
  assetId: string;
  assetName: string | null;
}

const NO_LONGER_OPEN = 'This difference is no longer open.';
const NO_WRITE = 'You cannot edit assets in this company.';

/**
 * Standard-field differences recorded by integration syncs: a person
 * changed a field the integration fills, so the sync left it alone.
 * Resolving one either writes the source value (the field follows the
 * source again) or keeps the person's value until the source changes.
 */
@Injectable()
export class IntegrationDifferencesService {
  private readonly log = new Logger(IntegrationDifferencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly assets: AssetsService,
    private readonly provenance: IntegrationProvenanceService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * The caller holds asset.write on `companyId` (route guard). The sync
   * record must belong to that asset in that company; anything else is a
   * 404 so a known id never crosses tenants.
   */
  async resolve(
    actor: AuthedUser,
    companyId: string,
    assetId: string,
    input: ResolveIntegrationDifferenceInput,
    meta: AuditMeta,
  ): Promise<{ ok: true }> {
    // Differences are MSP-internal, like the integration sections.
    if (actor.role === 'CLIENT_USER') throw new ForbiddenException();
    const record = await this.prisma.integrationSyncRecord.findFirst({
      where: { id: input.syncRecordId, companyId, assetId, targetKind: 'asset' },
      select: {
        id: true,
        updatedAt: true,
        fieldDiffs: true,
        fieldResolutions: true,
        lastSyncedFieldChecksums: true,
        integrationCompanyMappingId: true,
        resourceId: true,
        companyMapping: { select: { integrationId: true } },
      },
    });
    if (!record) throw new NotFoundException();
    const diffs = parseFieldDiffs(record.fieldDiffs);
    const diff = diffs[input.assetFieldId];
    if (!diff) throw new NotFoundException('This difference is no longer open.');
    const resolutions = parseFieldResolutions(record.fieldResolutions);
    const checksums = { ...((record.lastSyncedFieldChecksums ?? {}) as Record<string, string>) };
    delete diffs[input.assetFieldId];
    delete resolutions[input.assetFieldId];

    let slug: string | null = null;
    if (input.choice === 'source') {
      const field = await this.prisma.assetField.findFirst({
        where: { id: input.assetFieldId, archivedAt: null, assetLayout: { assets: { some: { id: assetId, companyId } } } },
        select: { slug: true },
      });
      if (!field) throw new NotFoundException();
      slug = field.slug;
      // Recorded as the integration's last write (the fingerprint of the
      // normalized source value the asset is about to hold), so the field
      // follows the source again.
      checksums[input.assetFieldId] = diff.sourceFingerprint;
    } else {
      resolutions[input.assetFieldId] = { choice: 'local', sourceFingerprint: diff.sourceFingerprint };
    }

    // One transaction under the sync runner's per-scope lock: a sync page
    // either finished before (the updatedAt guard then refuses, nothing is
    // written) or waits until the record and the asset are both updated.
    await this.prisma.$transaction(async (tx) => {
      await this.provenance.lockScope(tx, {
        companyId,
        integrationCompanyMappingId: record.integrationCompanyMappingId,
        resourceId: record.resourceId,
        observedAt: new Date(),
      });
      const updated = await tx.integrationSyncRecord.updateMany({
        where: { id: record.id, companyId, updatedAt: record.updatedAt },
        data: {
          fieldDiffs: diffs as unknown as Prisma.InputJsonValue,
          fieldResolutions: resolutions as unknown as Prisma.InputJsonValue,
          lastSyncedFieldChecksums: checksums as Prisma.InputJsonValue,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('The integration synced this asset just now. Reload and try again.');
      }
      if (slug !== null) {
        // The operator write path: validated, audited and indexed like any
        // edit; a failure rolls the record change back with it.
        await this.assets.update(actor, companyId, assetId, { fieldValues: { [slug]: diff.sourceValue } }, meta, tx);
      }
      // Same transaction: a failed audit write rolls the resolution back,
      // so no resolution commits without its row.
      await this.audit.logWithClient(tx, {
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.differenceResolve,
        entityType: 'Asset',
        entityId: assetId,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          integrationId: record.companyMapping.integrationId,
          syncRecordId: record.id,
          assetFieldId: input.assetFieldId,
          choice: input.choice,
        },
      });
    });
    return { ok: true };
  }

  /**
   * Differences tab bulk action (route guard: integration.manage). Each
   * difference goes through `resolve` (same transaction, sync lock and
   * audit row); asset.write is checked once per company, and differences
   * in a company the actor cannot edit are skipped and reported. Items
   * mode takes at most INTEGRATION_DIFFERENCES_BULK_MAX differences. Filter
   * mode returns a `nextCursor` for the next batch and never splits a sync
   * record across batches, so a batch whose first record alone holds more
   * than INTEGRATION_DIFFERENCES_BULK_MAX differences takes them all and
   * exceeds the cap.
   */
  async resolveBulk(
    actor: AuthedUser,
    integrationId: string,
    input: ResolveIntegrationDifferencesBulkInput,
    meta: AuditMeta,
  ): Promise<IntegrationDifferencesBulkResult> {
    if (actor.role === 'CLIENT_USER') throw new ForbiddenException();
    const mapped = await this.mappedCompanyIds(integrationId);
    const skipped: IntegrationDifferenceBulkMiss[] = [];
    const failed: IntegrationDifferenceBulkMiss[] = [];
    const { targets, nextCursor } = input.items
      ? await this.selectItems(integrationId, mapped, input.items, skipped)
      : await this.selectByFilter(integrationId, mapped, input.filter ?? {});

    const canWrite = new Map<string, boolean>();
    for (const companyId of new Set(targets.map((t) => t.companyId))) {
      canWrite.set(companyId, (await this.permissions.can(actor, 'asset.write', { companyId })).allowed);
    }

    let applied = 0;
    for (const target of targets) {
      const miss = { syncRecordId: target.syncRecordId, assetFieldId: target.assetFieldId, assetName: target.assetName };
      if (!canWrite.get(target.companyId)) {
        skipped.push({ ...miss, reason: NO_WRITE });
        continue;
      }
      try {
        await this.inCompanyScope([target.companyId], () =>
          this.resolve(actor, target.companyId, target.assetId, {
            syncRecordId: target.syncRecordId,
            assetFieldId: target.assetFieldId,
            choice: input.choice,
          }, meta),
        );
        applied += 1;
      } catch (error) {
        if (error instanceof NotFoundException) {
          skipped.push({ ...miss, reason: NO_LONGER_OPEN });
        } else if (error instanceof ForbiddenException) {
          skipped.push({ ...miss, reason: NO_WRITE });
        } else if (error instanceof ConflictException) {
          failed.push({ ...miss, reason: 'The integration synced this asset just now. Try again.' });
        } else if (error instanceof BadRequestException) {
          failed.push({ ...miss, reason: 'The source value does not fit this field.' });
        } else {
          // One bad item must not stop the batch; the reason stays generic.
          this.log.error(`Bulk difference resolve failed for sync record ${target.syncRecordId}`, error instanceof Error ? error.stack : undefined);
          failed.push({ ...miss, reason: 'Could not resolve this difference.' });
        }
      }
    }

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.differenceResolveBulk,
      entityType: 'Integration',
      entityId: integrationId,
      companyId: input.filter?.companyId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        choice: input.choice,
        mode: input.items ? 'items' : 'filter',
        companyId: input.filter?.companyId ?? null,
        applied,
        skipped: skipped.length,
        failed: failed.length,
      },
    });
    return { applied, skipped, failed, nextCursor };
  }

  private async mappedCompanyIds(integrationId: string): Promise<string[]> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { companyMappings: { select: { companyId: true } } },
    });
    if (!integration) throw new NotFoundException(`Integration ${integrationId} not found`);
    return [...new Set(integration.companyMappings.map((mapping) => mapping.companyId))];
  }

  /** The ticked rows, kept only when they belong to this integration and are still open. */
  private async selectItems(
    integrationId: string,
    mapped: string[],
    items: Array<{ syncRecordId: string; assetFieldId: string }>,
    skipped: IntegrationDifferenceBulkMiss[],
  ): Promise<{ targets: BulkTarget[]; nextCursor: null }> {
    const unique = [...new Map(items.map((item) => [`${item.syncRecordId}:${item.assetFieldId}`, item])).values()];
    const rows = mapped.length === 0
      ? []
      : await this.inCompanyScope(mapped, () =>
          this.prisma.integrationSyncRecord.findMany({
            where: {
              id: { in: [...new Set(unique.map((item) => item.syncRecordId))] },
              companyId: { in: mapped },
              targetKind: 'asset',
              assetId: { not: null },
              companyMapping: { integrationId },
            },
            select: { id: true, companyId: true, assetId: true, fieldDiffs: true, asset: { select: { name: true } } },
          }),
        );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const targets: BulkTarget[] = [];
    for (const item of unique) {
      const row = byId.get(item.syncRecordId);
      if (!row?.assetId || !parseFieldDiffs(row.fieldDiffs)[item.assetFieldId]) {
        skipped.push({ ...item, assetName: row?.asset?.name ?? null, reason: NO_LONGER_OPEN });
        continue;
      }
      targets.push({ ...item, companyId: row.companyId, assetId: row.assetId, assetName: row.asset?.name ?? null });
    }
    return { targets, nextCursor: null };
  }

  /**
   * Open differences matching the tab's filter, in sync record order after
   * the cursor, up to the cap; a record's differences are never split
   * across batches, so the cursor is the last record taken.
   */
  private async selectByFilter(
    integrationId: string,
    mapped: string[],
    filter: { companyId?: string; cursor?: string },
  ): Promise<{ targets: BulkTarget[]; nextCursor: string | null }> {
    if (filter.companyId && !mapped.includes(filter.companyId)) {
      throw new NotFoundException('That company is not mapped to this integration.');
    }
    const companyIds = filter.companyId ? [filter.companyId] : mapped;
    if (companyIds.length === 0) return { targets: [], nextCursor: null };
    const rows = await this.inCompanyScope(companyIds, () =>
      this.prisma.integrationSyncRecord.findMany({
        where: {
          ...HAS_DIFFS,
          companyId: { in: companyIds },
          targetKind: 'asset',
          assetId: { not: null },
          companyMapping: { integrationId },
          ...(filter.cursor ? { id: { gt: filter.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: INTEGRATION_DIFFERENCES_BULK_MAX + 1,
        select: { id: true, companyId: true, assetId: true, fieldDiffs: true, asset: { select: { name: true } } },
      }),
    );
    const targets: BulkTarget[] = [];
    let lastTaken: string | null = null;
    for (const row of rows) {
      if (!row.assetId) continue;
      const fieldIds = Object.keys(parseFieldDiffs(row.fieldDiffs));
      if (targets.length > 0 && targets.length + fieldIds.length > INTEGRATION_DIFFERENCES_BULK_MAX) {
        return { targets, nextCursor: lastTaken };
      }
      for (const assetFieldId of fieldIds) {
        targets.push({ syncRecordId: row.id, assetFieldId, companyId: row.companyId, assetId: row.assetId, assetName: row.asset?.name ?? null });
      }
      lastTaken = row.id;
    }
    return { targets, nextCursor: rows.length > INTEGRATION_DIFFERENCES_BULK_MAX ? lastTaken : null };
  }

  /** Open differences across the integration's mapped companies (integration.manage). */
  async list(integrationId: string, query: IntegrationDifferencesQuery): Promise<IntegrationDifferencesPage> {
    const mapped = await this.mappedCompanyIds(integrationId);
    if (query.companyId && !mapped.includes(query.companyId)) {
      throw new NotFoundException('That company is not mapped to this integration.');
    }
    const companyIds = query.companyId ? [query.companyId] : mapped;
    if (companyIds.length === 0) return { items: [], total: 0, nextCursor: null };
    const where: Prisma.IntegrationSyncRecordWhereInput = {
      ...HAS_DIFFS,
      companyId: { in: companyIds },
      targetKind: 'asset',
      assetId: { not: null },
      companyMapping: { integrationId },
    };
    return this.inCompanyScope(companyIds, async () => {
      const rows = await this.prisma.integrationSyncRecord.findMany({
        where: { ...where, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        select: {
          id: true,
          companyId: true,
          assetId: true,
          fieldDiffs: true,
          asset: { select: { name: true, company: { select: { name: true } } } },
        },
      });
      const page = rows.slice(0, query.limit);
      const diffsByRow = new Map(page.map((row) => [row.id, parseFieldDiffs(row.fieldDiffs)]));
      const fieldIds = [...new Set([...diffsByRow.values()].flatMap((diffs) => Object.keys(diffs)))];
      const assetIds = page.flatMap((row) => (row.assetId ? [row.assetId] : []));
      const [fields, values] = fieldIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.assetField.findMany({
              where: { id: { in: fieldIds }, archivedAt: null },
              select: { id: true, name: true },
            }),
            this.prisma.assetFieldValue.findMany({
              where: { companyId: { in: companyIds }, assetId: { in: assetIds }, assetFieldId: { in: fieldIds } },
              select: { assetId: true, assetFieldId: true, value: true },
            }),
          ]);
      const labelById = new Map(fields.map((field) => [field.id, field.name]));
      const valueByKey = new Map(values.map((value) => [`${value.assetId}:${value.assetFieldId}`, value.value]));
      const items: IntegrationDifferenceRowDto[] = [];
      for (const row of page) {
        if (!row.assetId || !row.asset) continue;
        for (const [assetFieldId, diff] of Object.entries(diffsByRow.get(row.id) ?? {})) {
          const fieldLabel = labelById.get(assetFieldId);
          if (fieldLabel === undefined) continue;
          items.push({
            syncRecordId: row.id,
            companyId: row.companyId,
            companyName: row.asset.company.name,
            assetId: row.assetId,
            assetName: row.asset.name,
            assetFieldId,
            fieldLabel,
            localValue: differenceDisplayValue(valueByKey.get(`${row.assetId}:${assetFieldId}`)),
            sourceValue: differenceDisplayValue(diff.sourceValue),
            detectedAt: diff.detectedAt,
          });
        }
      }
      // ponytail: counts every stored diff (archived fields included); a SQL
      // jsonb key count can replace this if a fleet ever holds thousands.
      const total = query.cursor
        ? null
        : (await this.prisma.integrationSyncRecord.findMany({ where, select: { fieldDiffs: true } }))
            .reduce((sum, row) => sum + Object.keys(parseFieldDiffs(row.fieldDiffs)).length, 0);
      const last = page[page.length - 1];
      return { items, total, nextCursor: rows.length > query.limit && last ? last.id : null };
    });
  }

  private inCompanyScope<T>(companyIds: string[], read: () => Promise<T>): Promise<T> {
    const tenant = getTenantContext();
    if (!tenant) return read();
    return runWithTenantContext({ ...tenant, allowedCompanyIds: companyIds }, read);
  }
}
