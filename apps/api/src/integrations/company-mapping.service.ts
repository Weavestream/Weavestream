import {
  ConflictException,
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateIntegrationCompanyMappingInput,
  IntegrationCompanyMappingDto,
  UpdateIntegrationCompanyMappingInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { assertStringIdList } from '../common/safe-id-list.js';

interface AuditMeta {
  ip: string;
  userAgent: string;
}

/**
 * Phase 11 — `IntegrationCompanyMapping` CRUD.
 *
 * After the global field-mapping refactor (D-021) this service ONLY
 * deals with the per-tenant fan-out row (which company, which upstream
 * org, optional driver filter, enabled flag). Asset layout, match-key
 * field ids, and field mappings are configured GLOBALLY on the parent
 * `Integration` and are applied uniformly across every per-company
 * mapping during sync.
 *
 * Mappings are TENANT-scoped (the row carries `companyId`), but every
 * mutation runs under a SUPER_ADMIN actor — the global integration
 * manager is the only role allowed by the controller. We still set
 * `companyId` correctly on every write so the tenant middleware
 * enforces consistency and the per-tenant audit log shows the change
 * to the affected company's operators.
 */
@Injectable()
export class IntegrationCompanyMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(integrationId: string): Promise<IntegrationCompanyMappingDto[]> {
    const rows = await this.prisma.integrationCompanyMapping.findMany({
      where: { integrationId },
      orderBy: [{ externalOrgName: 'asc' }, { externalOrgId: 'asc' }],
      include: {
        company: { select: { name: true } },
      },
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(
    integrationId: string,
    mappingId: string,
  ): Promise<IntegrationCompanyMappingDto> {
    return this.toDto(await this.loadMapping(integrationId, mappingId));
  }

  async create(
    actor: AuthedUser,
    integrationId: string,
    input: CreateIntegrationCompanyMappingInput,
    meta: AuditMeta,
  ): Promise<IntegrationCompanyMappingDto> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });
    if (!integration) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }

    await this.assertCompany(input.companyId);

    try {
      const row = await this.prisma.integrationCompanyMapping.create({
        data: {
          integrationId,
          companyId: input.companyId,
          externalOrgId: input.externalOrgId,
          externalOrgName: input.externalOrgName ?? null,
          enabled: input.enabled ?? true,
          filter: (input.filter ?? {}) as Prisma.InputJsonValue,
          createdBy: actor.id,
        },
      });

      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.companyMappingCreate,
        entityType: 'IntegrationCompanyMapping',
        entityId: row.id,
        companyId: input.companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          integrationId,
          externalOrgId: input.externalOrgId,
          enabled: row.enabled,
        },
      });
      return this.get(integrationId, row.id);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `Source organisation "${input.externalOrgId}" is already mapped to a Weavestream company for this integration.`,
        );
      }
      throw e;
    }
  }

  async update(
    actor: AuthedUser,
    integrationId: string,
    mappingId: string,
    input: UpdateIntegrationCompanyMappingInput,
    meta: AuditMeta,
  ): Promise<IntegrationCompanyMappingDto> {
    const existing = await this.loadMapping(integrationId, mappingId);

    if (input.companyId) await this.assertCompany(input.companyId);

    const before = {
      companyId: existing.companyId,
      externalOrgName: existing.externalOrgName,
      enabled: existing.enabled,
      filter: existing.filter,
    };

    // `updateMany` rather than `update` so we can carry `companyId`
    // in the `where` clause for the tenant guard. The mapping id is
    // unique so this still touches at most one row.
    await this.prisma.integrationCompanyMapping.updateMany({
      where: { id: mappingId, companyId: existing.companyId },
      data: {
        companyId: input.companyId ?? undefined,
        externalOrgName:
          input.externalOrgName === undefined
            ? undefined
            : input.externalOrgName ?? null,
        enabled: input.enabled ?? undefined,
        filter: input.filter
          ? (input.filter as Prisma.InputJsonValue)
          : undefined,
      },
    });

    const fresh = await this.get(integrationId, mappingId);
    await this.audit.logChange({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.companyMappingUpdate,
      entityType: 'IntegrationCompanyMapping',
      entityId: mappingId,
      companyId: fresh.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before,
      after: {
        companyId: fresh.companyId,
        externalOrgName: fresh.externalOrgName,
        enabled: fresh.enabled,
        filter: fresh.filter,
      },
      fields: ['companyId', 'externalOrgName', 'enabled', 'filter'],
    });
    return fresh;
  }

  /**
   * Delete a company-mapping. Mirrors the integration-delete safety:
   * never delete or archive any Asset; clear `external_id` /
   * `external_source` on the affected assets and hard-delete every
   * sync record (cascade FKs handle the rest).
   */
  async delete(
    actor: AuthedUser,
    integrationId: string,
    mappingId: string,
    meta: AuditMeta,
  ): Promise<void> {
    const existing = await this.loadMapping(integrationId, mappingId);

    const records = await this.prisma.integrationSyncRecord.findMany({
      where: { integrationCompanyMappingId: mappingId },
      select: { assetId: true, companyId: true },
    });
    const releasedAssetIds = records.map((r) => r.assetId);

    await this.prisma.$transaction(async (tx) => {
      if (releasedAssetIds.length > 0) {
        const safeAssetIds = assertStringIdList(releasedAssetIds, 'releasedAssetIds');
        // Tenant middleware requires `companyId` on every write to a
        // tenant-scoped model; the mapping carries a single companyId
        // so every sync record + asset under it shares it.
        await tx.integrationSyncRecord.deleteMany({
          where: {
            integrationCompanyMappingId: mappingId,
            companyId: existing.companyId,
          },
        });
        // Phase 11.2 — multi-integration assets stay linked to their
        // OTHER owners when this mapping disappears. Only the assets
        // that no longer have any sync records get their denormalised
        // externalId / externalSource cleared.
        const stillLinked = await tx.integrationSyncRecord.findMany({
          where: { assetId: { in: safeAssetIds } },
          select: { assetId: true },
        });
        const stillLinkedIds = new Set(stillLinked.map((r) => r.assetId));
        const releasableAssetIds = safeAssetIds.filter(
          (id) => !stillLinkedIds.has(id),
        );
        if (releasableAssetIds.length > 0) {
          await tx.asset.updateMany({
            where: {
              id: { in: releasableAssetIds },
              companyId: { equals: existing.companyId },
            },
            data: { externalId: null, externalSource: null },
          });
        }
      }
      // `deleteMany` instead of `delete` so we can satisfy the tenant
      // guard with the `companyId` filter in the `where` clause.
      await tx.integrationCompanyMapping.deleteMany({
        where: { id: mappingId, companyId: existing.companyId },
      });
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.companyMappingDelete,
      entityType: 'IntegrationCompanyMapping',
      entityId: mappingId,
      companyId: existing.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { externalOrgId: existing.externalOrgId },
      after: { releasedAssetCount: releasedAssetIds.length },
    });
    for (const r of records) {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.assetReleased,
        entityType: 'Asset',
        entityId: r.assetId,
        companyId: r.companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: null,
      });
    }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private async loadMapping(integrationId: string, mappingId: string) {
    const row = await this.prisma.integrationCompanyMapping.findFirst({
      where: { id: mappingId, integrationId },
      include: {
        company: { select: { name: true } },
      },
    });
    if (!row) {
      throw new NotFoundException(
        `Integration mapping ${mappingId} not found for integration ${integrationId}`,
      );
    }
    return row;
  }

  private async assertCompany(companyId: string): Promise<void> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, archivedAt: true },
    });
    if (!c) throw new BadRequestException(`Company ${companyId} not found`);
    if (c.archivedAt) {
      throw new BadRequestException(
        `Company ${companyId} is archived and cannot receive synced data.`,
      );
    }
  }

  private toDto(row: {
    id: string;
    integrationId: string;
    companyId: string;
    externalOrgId: string;
    externalOrgName: string | null;
    enabled: boolean;
    filter: unknown;
    createdAt: Date;
    updatedAt: Date;
    company?: { name: string } | null;
  }): IntegrationCompanyMappingDto {
    return {
      id: row.id,
      integrationId: row.integrationId,
      companyId: row.companyId,
      companyName: row.company?.name ?? null,
      externalOrgId: row.externalOrgId,
      externalOrgName: row.externalOrgName,
      enabled: row.enabled,
      filter: (row.filter ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
