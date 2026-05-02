import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateIntegrationInput,
  CreateIntegrationResourceInput,
  DriverDescriptor,
  DriverResourceDescriptor,
  IntegrationDto,
  IntegrationFieldMappingDto,
  IntegrationResourceDto,
  ReplaceFieldMappingsInput,
  UpdateIntegrationInput,
  UpdateIntegrationResourceInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { IntegrationSecretEncryptionService } from '../crypto/integration-secret-encryption.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { EnvService } from '../config/env.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { Prisma } from '@prisma/client';
import { assertStringIdList } from '../common/safe-id-list.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

/**
 * Phase 11 — global Integration CRUD.
 *
 * `Integration` and `IntegrationSecret` rows are GLOBAL — every method
 * here is gated by `integration.manage` at the controller layer (which
 * is in turn SUPER_ADMIN-only). The service NEVER returns plaintext
 * secrets — only a fingerprint mask suitable for the admin UI.
 *
 * Phase 11.1 — per-resource configuration. Each Integration owns one or
 * more `IntegrationResource` rows (one per driver-declared resource:
 * UniFi -> devices + clients, Action1 -> records). Field mappings,
 * asset layout, and match keys live on the resource container; this
 * service exposes the per-resource read/write methods consumed by the
 * controller and the sync runner.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly audit: AuditLogService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly env: EnvService,
  ) {}

  // -------------------------------------------------------------------
  // Driver descriptors (UI populates the type picker from this).
  // -------------------------------------------------------------------

  listDrivers(): DriverDescriptor[] {
    return this.drivers.list();
  }

  // -------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------

  async list(): Promise<IntegrationDto[]> {
    const rows = await this.prisma.integration.findMany({
      orderBy: [{ driver: 'asc' }, { name: 'asc' }],
      include: {
        secret: { select: { ciphertext: true } },
        resources: this.resourceInclude(),
        _count: { select: { companyMappings: true } },
      },
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(id: string): Promise<IntegrationDto> {
    const row = await this.prisma.integration.findUnique({
      where: { id },
      include: {
        secret: { select: { ciphertext: true } },
        resources: this.resourceInclude(),
        _count: { select: { companyMappings: true } },
      },
    });
    if (!row) throw new NotFoundException(`Integration ${id} not found`);
    return this.toDto(row);
  }

  async create(
    actor: AuthedUser,
    input: CreateIntegrationInput,
    meta: AuditMeta,
  ): Promise<IntegrationDto> {
    const driver = this.drivers.get(input.driver);
    this.validateDriverPayload(driver.descriptor, input.config, input.secret);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.integration.create({
        data: {
          driver: input.driver,
          name: input.name,
          status: input.status ?? 'PAUSED',
          config: (input.config ?? {}) as Prisma.InputJsonValue,
          syncCron: input.syncCron ?? null,
          createdBy: actor.id,
        },
      });
      // Seed one IntegrationResource row per driver-declared resource so
      // the operator can immediately pick a layout per resource without
      // a separate "enable resource" round-trip. Newly added driver
      // resources (e.g. UniFi adds 'clients' later) are auto-seeded for
      // existing integrations on next API read via reconcileResources().
      for (const r of driver.descriptor.resources) {
        await tx.integrationResource.create({
          data: {
            integrationId: row.id,
            resourceKey: r.key,
            enabled: true,
          },
        });
      }
      if (input.secret && Object.keys(input.secret).length > 0) {
        await tx.integrationSecret.create({
          data: {
            integrationId: row.id,
            ciphertext: this.crypto.encrypt(JSON.stringify(input.secret)),
          },
        });
      }
      return row;
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.create,
      entityType: 'Integration',
      entityId: created.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        driver: created.driver,
        name: created.name,
        status: created.status,
        hasSecret: Boolean(input.secret),
        resources: driver.descriptor.resources.map((r) => r.key),
      },
    });

    return this.get(created.id);
  }

  async update(
    actor: AuthedUser,
    id: string,
    input: UpdateIntegrationInput,
    meta: AuditMeta,
  ): Promise<IntegrationDto> {
    const existing = await this.prisma.integration.findUnique({
      where: { id },
      include: { secret: true },
    });
    if (!existing) throw new NotFoundException(`Integration ${id} not found`);
    const driver = this.drivers.get(existing.driver);

    if (input.config) {
      this.validateDriverPayload(driver.descriptor, input.config, input.secret);
    } else if (input.secret) {
      this.validateDriverPayload(driver.descriptor, null, input.secret);
    }

    const before = {
      name: existing.name,
      status: existing.status,
      config: existing.config,
      syncCron: existing.syncCron,
      hasSecret: Boolean(existing.secret),
    };

    let secretMutated = false;
    await this.prisma.$transaction(async (tx) => {
      await tx.integration.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          status: input.status ?? undefined,
          config: input.config
            ? (input.config as Prisma.InputJsonValue)
            : undefined,
          syncCron:
            input.syncCron === undefined ? undefined : input.syncCron ?? null,
        },
      });

      if (input.clearSecret) {
        await tx.integrationSecret.deleteMany({
          where: { integrationId: { equals: id } },
        });
        secretMutated = true;
      } else if (input.secret) {
        const ciphertext = this.crypto.encrypt(JSON.stringify(input.secret));
        await tx.integrationSecret.upsert({
          where: { integrationId: id },
          create: { integrationId: id, ciphertext },
          update: { ciphertext },
        });
        secretMutated = true;
      }
    });

    const fresh = await this.get(id);
    await this.audit.logChange({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.update,
      entityType: 'Integration',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before,
      after: {
        name: fresh.name,
        status: fresh.status,
        config: fresh.config,
        syncCron: fresh.syncCron,
        hasSecret: fresh.hasSecret,
      },
      fields: ['name', 'status', 'config', 'syncCron', 'hasSecret'],
    });
    if (secretMutated) {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.secretUpdate,
        entityType: 'Integration',
        entityId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: { cleared: input.clearSecret === true },
      });
    }
    return fresh;
  }

  /**
   * Delete an Integration AND every framework-side row that depends on it,
   * but DO NOT delete or archive any Asset. Affected assets are released
   * (external_id/external_source cleared) so they remain for the operator
   * with no link to the now-defunct integration.
   */
  async delete(actor: AuthedUser, id: string, meta: AuditMeta): Promise<void> {
    const existing = await this.prisma.integration.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Integration ${id} not found`);

    // Snapshot affected asset ids BEFORE the cascade deletes the
    // sync-records rows. We then clear their external linkage so the
    // assets persist as plain operator-owned rows.
    const records = await this.prisma.integrationSyncRecord.findMany({
      where: { companyMapping: { integrationId: id } },
      select: { assetId: true, companyId: true },
    });

    const releasedAssetIds = records.map((r) => r.assetId);

    // Tenant middleware requires `companyId` on every write to a
    // tenant-scoped model (`IntegrationSyncRecord`, `Asset`). An
    // integration can fan out across many companies, so we collect the
    // distinct set of affected company ids and pass them as `in: [...]`.
    const affectedCompanyIds = Array.from(
      new Set(records.map((r) => r.companyId)),
    );

    await this.prisma.$transaction(async (tx) => {
      if (releasedAssetIds.length > 0) {
        const safeAssetIds = assertStringIdList(releasedAssetIds, 'releasedAssetIds');
        const safeCompanyIds = assertStringIdList(
          affectedCompanyIds,
          'affectedCompanyIds',
        );
        // Cascade FKs would delete the sync-records rows when we
        // drop the parent integration anyway, but doing it explicitly
        // first lets us check the "is this asset still linked to any
        // OTHER integration?" question below.
        await tx.integrationSyncRecord.deleteMany({
          where: {
            assetId: { in: safeAssetIds },
            companyId: { in: safeCompanyIds },
            companyMapping: { integrationId: id },
          },
        });
        // Phase 11.2 — assets linked to multiple integrations keep
        // their identity when one integration disappears. Only the
        // assets with no remaining sync records get released.
        const stillLinked = await tx.integrationSyncRecord.findMany({
          where: { assetId: { in: safeAssetIds } },
          select: { assetId: true },
        });
        const stillLinkedIds = new Set(stillLinked.map((r) => r.assetId));
        const releasableAssetIds = safeAssetIds.filter(
          (idCandidate) => !stillLinkedIds.has(idCandidate),
        );
        if (releasableAssetIds.length > 0) {
          await tx.asset.updateMany({
            where: {
              id: { in: releasableAssetIds },
              companyId: { in: safeCompanyIds },
              externalSource: existing.driver,
            },
            data: { externalId: null, externalSource: null },
          });
        }
      }
      await tx.integration.delete({ where: { id } });
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.delete,
      entityType: 'Integration',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { driver: existing.driver, name: existing.name },
      after: {
        releasedAssetCount: releasedAssetIds.length,
      },
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
        before: { externalSource: existing.driver },
        after: { externalSource: null },
      });
    }
  }

  // -------------------------------------------------------------------
  // Decryption helpers (used by services in this module + worker)
  // -------------------------------------------------------------------

  /**
   * Returns the decoded credential bundle for a given Integration, plus
   * the active config. Throws 400 if no secret is configured. Callers
   * that don't need the secret (e.g. the orgs lister with a stale
   * connection) should still go through here so the decrypt failure
   * mode is consistent.
   */
  async loadDriverContext(id: string): Promise<{
    integrationId: string;
    driver: string;
    config: Record<string, unknown>;
    secret: Record<string, unknown>;
  }> {
    const row = await this.prisma.integration.findUnique({
      where: { id },
      include: { secret: true },
    });
    if (!row) throw new NotFoundException(`Integration ${id} not found`);
    if (!row.secret) {
      throw new BadRequestException(
        'Integration has no credential bundle configured.',
      );
    }
    let secret: Record<string, unknown>;
    try {
      const json = this.crypto.decrypt(row.secret.ciphertext);
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('decrypted secret is not a JSON object');
      }
      secret = parsed as Record<string, unknown>;
    } catch (e) {
      this.logger.error(
        { err: (e as Error).message, integrationId: id },
        'failed to decrypt integration secret',
      );
      throw new ConflictException(
        'Stored integration secret could not be decrypted (key rotated?).',
      );
    }

    return {
      integrationId: row.id,
      driver: row.driver,
      config: (row.config ?? {}) as Record<string, unknown>,
      secret,
    };
  }

  // -------------------------------------------------------------------
  // Resources (per-integration, per-resource configuration)
  // -------------------------------------------------------------------

  /**
   * Reconcile the Integration's `IntegrationResource` rows against the
   * driver's current `descriptor.resources`. Auto-seeds rows for any
   * driver resource that doesn't have one yet (e.g. when UniFi adds a
   * new resource key to existing tenants). Idempotent.
   *
   * Does NOT remove rows for descriptor resources that disappeared —
   * that would silently destroy operator config; we leave them in place
   * (the API may surface a deprecation warning later).
   */
  async reconcileResources(integrationId: string): Promise<void> {
    const integration = await this.requireIntegration(integrationId);
    const driver = this.drivers.get(integration.driver);
    const existing = await this.prisma.integrationResource.findMany({
      where: { integrationId },
      select: { resourceKey: true },
    });
    const existingKeys = new Set(existing.map((e) => e.resourceKey));
    for (const r of driver.descriptor.resources) {
      if (existingKeys.has(r.key)) continue;
      await this.prisma.integrationResource.create({
        data: {
          integrationId,
          resourceKey: r.key,
          enabled: true,
        },
      });
    }
  }

  async listResources(integrationId: string): Promise<IntegrationResourceDto[]> {
    const integration = await this.requireIntegration(integrationId);
    await this.reconcileResources(integrationId);
    const driver = this.drivers.get(integration.driver);
    const rows = await this.prisma.integrationResource.findMany({
      where: { integrationId },
      include: {
        assetLayout: { select: { name: true } },
        _count: { select: { fieldMappings: true } },
      },
    });
    return this.sortResources(driver, rows.map((r) => this.toResourceDto(driver, r)));
  }

  async getResource(
    integrationId: string,
    resourceKey: string,
  ): Promise<IntegrationResourceDto> {
    const integration = await this.requireIntegration(integrationId);
    const driver = this.drivers.get(integration.driver);
    this.assertResourceKey(driver.descriptor, resourceKey);
    const row = await this.findOrCreateResource(integrationId, resourceKey);
    return this.toResourceDto(driver, row);
  }

  async createResource(
    actor: AuthedUser,
    integrationId: string,
    input: CreateIntegrationResourceInput,
    meta: AuditMeta,
  ): Promise<IntegrationResourceDto> {
    const integration = await this.requireIntegration(integrationId);
    const driver = this.drivers.get(integration.driver);
    this.assertResourceKey(driver.descriptor, input.resourceKey);
    const existing = await this.prisma.integrationResource.findUnique({
      where: {
        integrationId_resourceKey: {
          integrationId,
          resourceKey: input.resourceKey,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        `Resource "${input.resourceKey}" is already enabled for this integration.`,
      );
    }
    await this.prisma.integrationResource.create({
      data: {
        integrationId,
        resourceKey: input.resourceKey,
        enabled: true,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.resourceCreate,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { resourceKey: input.resourceKey },
    });
    return this.getResource(integrationId, input.resourceKey);
  }

  async updateResource(
    actor: AuthedUser,
    integrationId: string,
    resourceKey: string,
    input: UpdateIntegrationResourceInput,
    meta: AuditMeta,
  ): Promise<IntegrationResourceDto> {
    const integration = await this.requireIntegration(integrationId);
    const driver = this.drivers.get(integration.driver);
    this.assertResourceKey(driver.descriptor, resourceKey);
    const existing = await this.findOrCreateResource(integrationId, resourceKey);
    const fieldMappingCount = await this.prisma.integrationFieldMapping.count({
      where: { resourceId: existing.id },
    });

    const nextLayoutId =
      input.assetLayoutId === undefined
        ? existing.assetLayoutId
        : input.assetLayoutId;

    if (input.assetLayoutId !== undefined) {
      if (input.assetLayoutId === null) {
        if (fieldMappingCount > 0) {
          throw new BadRequestException(
            'Remove all field mappings before detaching the asset layout.',
          );
        }
      } else {
        await this.assertLayout(input.assetLayoutId);
        if (
          existing.assetLayoutId &&
          existing.assetLayoutId !== input.assetLayoutId &&
          fieldMappingCount > 0
        ) {
          throw new BadRequestException(
            'Remove all field mappings before changing the asset layout.',
          );
        }
      }
    }

    const nextMatchKeys = input.matchKeyFieldIds ?? existing.matchKeyFieldIds;
    if (input.matchKeyFieldIds !== undefined) {
      if (!nextLayoutId && nextMatchKeys.length > 0) {
        throw new BadRequestException(
          'Cannot configure match-key fields before an asset layout is selected.',
        );
      }
      if (nextLayoutId) {
        await this.assertMatchKeysOnLayout(nextLayoutId, nextMatchKeys);
      }
    }

    const before = {
      enabled: existing.enabled,
      assetLayoutId: existing.assetLayoutId,
      matchKeyFieldIds: existing.matchKeyFieldIds,
    };

    await this.prisma.integrationResource.update({
      where: { id: existing.id },
      data: {
        enabled: input.enabled ?? undefined,
        assetLayoutId:
          input.assetLayoutId === undefined
            ? undefined
            : input.assetLayoutId ?? null,
        matchKeyFieldIds:
          input.matchKeyFieldIds === undefined
            ? undefined
            : input.matchKeyFieldIds,
      },
    });

    const fresh = await this.getResource(integrationId, resourceKey);
    await this.audit.logChange({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.resourceUpdate,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before,
      after: {
        enabled: fresh.enabled,
        assetLayoutId: fresh.assetLayoutId,
        matchKeyFieldIds: fresh.matchKeyFieldIds,
      },
      fields: ['enabled', 'assetLayoutId', 'matchKeyFieldIds'],
    });
    return fresh;
  }

  // -------------------------------------------------------------------
  // Field-mapping CRUD (per-resource — replace-all per resource)
  // -------------------------------------------------------------------

  async listFieldMappings(
    integrationId: string,
    resourceKey: string,
  ): Promise<IntegrationFieldMappingDto[]> {
    const integration = await this.requireIntegration(integrationId);
    const driver = this.drivers.get(integration.driver);
    this.assertResourceKey(driver.descriptor, resourceKey);
    const resource = await this.findOrCreateResource(integrationId, resourceKey);
    const rows = await this.prisma.integrationFieldMapping.findMany({
      where: { resourceId: resource.id },
      orderBy: { sourceField: 'asc' },
      include: {
        targetField: {
          select: { name: true, slug: true, fieldType: true },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      resourceId: r.resourceId,
      resourceKey,
      sourceField: r.sourceField,
      targetFieldId: r.targetFieldId,
      targetFieldName: r.targetField?.name ?? null,
      targetFieldSlug: r.targetField?.slug ?? null,
      targetFieldType: r.targetField?.fieldType ?? null,
      syncDirection: r.syncDirection,
      transform: (r.transform ?? null) as Record<string, unknown> | null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async replaceFieldMappings(
    actor: AuthedUser,
    integrationId: string,
    resourceKey: string,
    input: ReplaceFieldMappingsInput,
    meta: AuditMeta,
  ): Promise<IntegrationFieldMappingDto[]> {
    const integration = await this.requireIntegration(integrationId);
    const driver = this.drivers.get(integration.driver);
    this.assertResourceKey(driver.descriptor, resourceKey);
    const resource = await this.findOrCreateResource(integrationId, resourceKey);
    if (!resource.assetLayoutId) {
      throw new BadRequestException(
        'Pick a target asset layout before configuring field mappings.',
      );
    }

    const seenSource = new Set<string>();
    const seenTarget = new Set<string>();
    for (const m of input.mappings) {
      const norm = m.sourceField.trim().toLowerCase();
      if (seenSource.has(norm)) {
        throw new BadRequestException(
          `Source field "${m.sourceField}" is mapped twice.`,
        );
      }
      if (seenTarget.has(m.targetFieldId)) {
        throw new BadRequestException(
          'A target field is mapped more than once (only one source field may write to a target).',
        );
      }
      seenSource.add(norm);
      seenTarget.add(m.targetFieldId);
    }
    if (input.mappings.length > 0) {
      const valid = await this.prisma.assetField.findMany({
        where: {
          id: { in: input.mappings.map((m) => m.targetFieldId) },
          assetLayoutId: resource.assetLayoutId,
          archivedAt: null,
        },
        select: { id: true },
      });
      const validSet = new Set(valid.map((v) => v.id));
      for (const m of input.mappings) {
        if (!validSet.has(m.targetFieldId)) {
          throw new BadRequestException(
            `Target field ${m.targetFieldId} does not belong to layout ${resource.assetLayoutId} or is archived.`,
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.integrationFieldMapping.deleteMany({
        where: { resourceId: { equals: resource.id } },
      });
      if (input.mappings.length > 0) {
        await tx.integrationFieldMapping.createMany({
          data: input.mappings.map((m) => ({
            resourceId: resource.id,
            sourceField: m.sourceField.trim(),
            targetFieldId: m.targetFieldId,
            syncDirection: m.syncDirection,
            transform: m.transform
              ? (m.transform as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          })),
        });
      }
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.fieldMappingsReplace,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { resourceKey, mappings: input.mappings.length },
    });

    return this.listFieldMappings(integrationId, resourceKey);
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private async requireIntegration(id: string) {
    const row = await this.prisma.integration.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Integration ${id} not found`);
    return row;
  }

  private async findOrCreateResource(
    integrationId: string,
    resourceKey: string,
  ) {
    const existing = await this.prisma.integrationResource.findUnique({
      where: { integrationId_resourceKey: { integrationId, resourceKey } },
      include: {
        assetLayout: { select: { name: true } },
        _count: { select: { fieldMappings: true } },
      },
    });
    if (existing) return existing;
    return this.prisma.integrationResource.create({
      data: {
        integrationId,
        resourceKey,
        enabled: true,
      },
      include: {
        assetLayout: { select: { name: true } },
        _count: { select: { fieldMappings: true } },
      },
    });
  }

  private assertResourceKey(
    descriptor: DriverDescriptor,
    resourceKey: string,
  ): void {
    const ok = descriptor.resources.some((r) => r.key === resourceKey);
    if (!ok) {
      throw new BadRequestException(
        `Driver "${descriptor.key}" does not declare a resource named "${resourceKey}".`,
      );
    }
  }

  private async assertLayout(assetLayoutId: string): Promise<void> {
    const l = await this.prisma.assetLayout.findUnique({
      where: { id: assetLayoutId },
      select: { id: true, archivedAt: true, isActive: true },
    });
    if (!l) {
      throw new BadRequestException(`Asset layout ${assetLayoutId} not found`);
    }
    if (l.archivedAt || !l.isActive) {
      throw new BadRequestException(
        `Asset layout ${assetLayoutId} is archived or inactive.`,
      );
    }
  }

  private async assertMatchKeysOnLayout(
    assetLayoutId: string,
    fieldIds: string[],
  ): Promise<void> {
    if (fieldIds.length === 0) return;
    const fields = await this.prisma.assetField.findMany({
      where: { id: { in: fieldIds }, assetLayoutId, archivedAt: null },
      select: { id: true },
    });
    const found = new Set(fields.map((f) => f.id));
    for (const id of fieldIds) {
      if (!found.has(id)) {
        throw new BadRequestException(
          `Match-key field ${id} is not on layout ${assetLayoutId} or is archived.`,
        );
      }
    }
  }

  private validateDriverPayload(
    descriptor: DriverDescriptor,
    config: Record<string, unknown> | null | undefined,
    secret: Record<string, unknown> | null | undefined,
  ): void {
    if (config) {
      for (const f of descriptor.configFields) {
        if (f.required && (config[f.key] === undefined || config[f.key] === null)) {
          throw new BadRequestException(
            `Driver "${descriptor.key}" requires config field "${f.key}".`,
          );
        }
      }
    }
    if (secret) {
      for (const f of descriptor.secretFields) {
        if (f.required && (secret[f.key] === undefined || secret[f.key] === null)) {
          throw new BadRequestException(
            `Driver "${descriptor.key}" requires secret field "${f.key}".`,
          );
        }
      }
    }
  }

  private resourceInclude() {
    return {
      include: {
        assetLayout: { select: { name: true } },
        _count: { select: { fieldMappings: true } },
      },
    } as const;
  }

  private toResourceDto(
    driver: { descriptor: DriverDescriptor },
    row: ResourceRowWithIncludes,
  ): IntegrationResourceDto {
    const descriptor = driver.descriptor.resources.find(
      (r) => r.key === row.resourceKey,
    );
    return {
      id: row.id,
      integrationId: row.integrationId,
      resourceKey: row.resourceKey,
      resourceLabel: descriptor?.label ?? row.resourceKey,
      enabled: row.enabled,
      assetLayoutId: row.assetLayoutId,
      assetLayoutName: row.assetLayout?.name ?? null,
      matchKeyFieldIds: row.matchKeyFieldIds,
      fieldMappingCount: row._count?.fieldMappings ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Stable resource ordering matches the driver descriptor so the UI
   * tab strip renders in the same order across every page load,
   * regardless of insert order in the table.
   */
  private sortResources(
    driver: { descriptor: DriverDescriptor },
    rows: IntegrationResourceDto[],
  ): IntegrationResourceDto[] {
    const order = new Map(
      driver.descriptor.resources.map((r, i) => [r.key, i] as const),
    );
    return [...rows].sort(
      (a, b) =>
        (order.get(a.resourceKey) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.resourceKey) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  private toDto(row: IntegrationRowWithIncludes): IntegrationDto {
    const driver = this.drivers.has(row.driver)
      ? this.drivers.get(row.driver)
      : null;
    const descriptorResources: DriverResourceDescriptor[] =
      driver?.descriptor.resources ?? [];
    const driverShim = {
      descriptor: {
        ...(driver?.descriptor ?? {}),
        resources: descriptorResources,
      } as DriverDescriptor,
    };

    let secretMask: Record<string, string> | null = null;
    if (row.secret) {
      try {
        const json = this.crypto.decrypt(row.secret.ciphertext);
        const parsed = JSON.parse(json) as Record<string, unknown>;
        secretMask = {};
        for (const [k, v] of Object.entries(parsed ?? {})) {
          if (typeof v === 'string' && v.length > 0) {
            secretMask[k] = v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
          }
        }
      } catch {
        secretMask = { _: '••••' };
      }
    }

    const resources = this.sortResources(
      driverShim,
      (row.resources ?? []).map((r) => this.toResourceDto(driverShim, r)),
    );

    const rawDefault = this.env.values.INTEGRATION_SYNC_DEFAULT_CRON;
    const defaultCron =
      rawDefault.toLowerCase() === 'off' ? null : rawDefault;
    return {
      id: row.id,
      driver: row.driver,
      name: row.name,
      status: row.status,
      config: (row.config ?? {}) as Record<string, unknown>,
      syncCron: row.syncCron,
      effectiveSyncCron: row.syncCron ?? defaultCron,
      hasSecret: Boolean(row.secret),
      secretMask,
      resources,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastRunStatus: row.lastRunStatus,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      mappingCount: row._count?.companyMappings ?? 0,
    };
  }
}

interface ResourceRowWithIncludes {
  id: string;
  integrationId: string;
  resourceKey: string;
  enabled: boolean;
  assetLayoutId: string | null;
  matchKeyFieldIds: string[];
  createdAt: Date;
  updatedAt: Date;
  assetLayout?: { name: string } | null;
  _count?: { fieldMappings?: number };
}

interface IntegrationRowWithIncludes {
  id: string;
  driver: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'DISABLED';
  config: unknown;
  syncCron: string | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  secret?: { ciphertext: string } | null;
  resources?: ResourceRowWithIncludes[];
  _count?: { companyMappings?: number };
}
