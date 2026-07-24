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
  IntegrationCompletenessQuery,
  IntegrationCompletenessResponse,
  IntegrationGapsPage,
  IntegrationGapsQuery,
  IntegrationNativeTarget,
} from '@weavestream/shared';
import {
  integrationCompletenessResponseSchema,
  integrationGapsPageSchema,
  reconstructionCompletenessCountsSchema,
  driverResourceDescriptorSchema,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IntegrationSecretEncryptionService,
  integrationSecretAad,
} from '../crypto/integration-secret-encryption.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { EnvService } from '../config/env.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { IntegrationSyncSchedulerService } from './integration-sync-scheduler.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { Prisma } from '@prisma/client';
import { assertStringIdList } from '../common/safe-id-list.js';
import { ReconstructionWriterRegistry } from './reconstruction/reconstruction-writer.registry.js';
import type { RecommendedDestination } from './drivers/integration-driver.js';
import { integrationAssetExternalSource } from './integration-asset-source.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { scanSensitiveMaterial } from './sensitive-material.js';
import {
  getTenantContext,
  runWithTenantContext,
} from '@weavestream/shared/server';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

type RecommendedDestinationPrisma = Pick<
  PrismaService,
  | 'integrationResource'
  | 'assetLayout'
  | 'assetField'
  | 'integrationFieldMapping'
  | '$transaction'
>;

type RecommendedDestinationTx = Pick<
  RecommendedDestinationPrisma,
  'integrationResource' | 'assetLayout' | 'assetField' | 'integrationFieldMapping'
>;

/**
 * Apply a driver's recommendation only to a completely untouched asset
 * resource. Layouts/fields are global and deterministic; resource ownership
 * and every administrator edit remain generic service concerns.
 */
export async function ensureResourceDestination(
  prisma: RecommendedDestinationPrisma,
  integrationId: string,
  resourceKey: string,
  recommendation: RecommendedDestination,
): Promise<void> {
  const apply = async (tx: RecommendedDestinationTx): Promise<void> => {
    const current = await tx.integrationResource.findUnique({
      where: { integrationId_resourceKey: { integrationId, resourceKey } },
      select: { id: true, assetLayoutId: true, _count: { select: { fieldMappings: true } } },
    });
    if (!current || current.assetLayoutId || current._count.fieldMappings > 0) return;

    let layout = await tx.assetLayout.findFirst({
      where: { slug: recommendation.layout.slug, archivedAt: null, isActive: true },
      select: { id: true, slug: true, isActive: true },
    });
    const createdLayout = layout === null;
    if (!layout) {
      layout = await tx.assetLayout.create({
        data: {
          ...recommendation.layout,
          position: 0,
        },
        select: { id: true, slug: true, isActive: true },
      });
    }
    if (layout.isActive === false) return;

    if (createdLayout) {
      await tx.assetField.createMany({
        data: recommendation.fields.map((field, index) => ({
          assetLayoutId: layout!.id,
          name: field.name,
          slug: field.slug,
          fieldType: field.fieldType,
          position: index,
          isRequired: false,
          isUniquePerCompany: false,
          visibleToClients: true,
          isPrimary: field.isPrimary,
          showInTable: field.showInTable,
          options: field.options as Prisma.InputJsonValue,
        })),
      });
    }
    const fields = await tx.assetField.findMany({
      where: {
        assetLayoutId: layout.id,
        archivedAt: null,
        slug: { in: recommendation.fields.map((field) => field.slug) },
      },
      select: { id: true, slug: true, fieldType: true },
    });
    const compatible = recommendation.fields.every((recommended) =>
      fields.some(
        (field) => field.slug === recommended.slug && field.fieldType === recommended.fieldType,
      ),
    );
    if (!compatible) {
      if (createdLayout) {
        throw new Error('Recommended destination field creation was incomplete.');
      }
      return;
    }
    const fieldBySlug = new Map(fields.map((field) => [field.slug, field.id]));
    const claimed = await tx.integrationResource.updateMany({
      where: {
        id: current.id,
        assetLayoutId: null,
        fieldMappings: { none: {} },
      },
      data: { assetLayoutId: layout!.id },
    });
    if (claimed.count !== 1) return;
    await tx.integrationFieldMapping.createMany({
      data: recommendation.fields
        .filter((field) => field.mapResource !== false)
        .map((field) => ({
          resourceId: current.id,
          sourceField: field.sourceField,
          targetKind: 'asset' as const,
          targetFieldId: fieldBySlug.get(field.slug)!,
          syncDirection: field.syncDirection,
          transform: Prisma.JsonNull,
        })),
      skipDuplicates: true,
    });
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) =>
        apply(tx as unknown as RecommendedDestinationTx),
      );
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      if (attempt === 1) return;
    }
  }
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
    private readonly scheduler: IntegrationSyncSchedulerService,
    private readonly writers: ReconstructionWriterRegistry,
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
    const descriptor = this.drivers.describe(input.driver);
    this.validateDriverPayload(descriptor, input.config, input.secret);
    this.validateDriverConfiguration(input.driver, input.config, input.secret);

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
      // Security drivers (e.g. Cloudflare) declare no resources — the
      // loop is a no-op for them.
      for (const r of descriptor.resources) {
        await tx.integrationResource.create({
          data: {
            integrationId: row.id,
            resourceKey: r.key,
            enabled: r.defaultEnabled ?? true,
            targetKind: r.targetKind,
            targetConfig: r.targetConfig as Prisma.InputJsonValue,
            dependsOnResourceKeys: r.dependsOnResourceKeys,
          },
        });
      }
      if (input.secret && Object.keys(input.secret).length > 0) {
        await tx.integrationSecret.create({
          data: {
            integrationId: row.id,
            ciphertext: this.crypto.encrypt(
              JSON.stringify(input.secret),
              integrationSecretAad(row.id),
            ),
          },
        });
      }
      return row;
    });

    if (descriptor.resources.length > 0) {
      const driver = this.drivers.get(input.driver);
      for (const resource of descriptor.resources) {
        const recommendation = driver.recommendedDestinations?.[resource.key];
        if (recommendation) {
          await ensureResourceDestination(this.prisma, created.id, resource.key, recommendation);
        }
      }
    }

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
        resources: descriptor.resources.map((r) => r.key),
      },
    });

    await this.scheduler.refreshFor(created.id);

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
    const descriptor = this.drivers.describe(existing.driver);

    if (input.config) {
      this.validateDriverPayload(descriptor, input.config, input.secret);
      this.validateDriverConfiguration(existing.driver, input.config, input.secret);
    } else if (input.secret) {
      this.validateDriverPayload(descriptor, null, input.secret);
      this.validateDriverConfiguration(existing.driver, null, input.secret);
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
          config: input.config ? (input.config as Prisma.InputJsonValue) : undefined,
          syncCron: input.syncCron === undefined ? undefined : (input.syncCron ?? null),
        },
      });

      if (input.clearSecret) {
        await tx.integrationSecret.deleteMany({
          where: { integrationId: { equals: id } },
        });
        secretMutated = true;
      } else if (input.secret) {
        const ciphertext = this.crypto.encrypt(
          JSON.stringify(input.secret),
          integrationSecretAad(id),
        );
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
    await this.scheduler.refreshFor(id);
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

    const releasedAssetIds = records
      .map((r) => r.assetId)
      .filter((assetId): assetId is string => assetId !== null);

    // Tenant middleware requires `companyId` on every write to a
    // tenant-scoped model (`IntegrationSyncRecord`, `Asset`). An
    // integration can fan out across many companies, so we collect the
    // distinct set of affected company ids and pass them as `in: [...]`.
    const affectedCompanyIds = Array.from(new Set(records.map((r) => r.companyId)));

    await this.prisma.$transaction(async (tx) => {
      if (releasedAssetIds.length > 0) {
        const safeAssetIds = assertStringIdList(releasedAssetIds, 'releasedAssetIds');
        const safeCompanyIds = assertStringIdList(affectedCompanyIds, 'affectedCompanyIds');
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
              externalSource: {
                in: [
                  existing.driver,
                  integrationAssetExternalSource(existing.driver, id),
                ],
              },
            },
            data: { externalId: null, externalSource: null },
          });
        }
      }
      await tx.integration.delete({ where: { id } });
    });

    await this.scheduler.refreshFor(id);

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
      // Native-backed sync records have no Asset to release. Their rows were
      // removed by the integration cascade, but they must not produce an
      // asset-release audit entry with a null entity id.
      if (r.assetId === null) continue;
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.assetReleased,
        entityType: 'Asset',
        entityId: r.assetId,
        companyId: r.companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: {
          externalSource: integrationAssetExternalSource(existing.driver, id),
          legacyExternalSource: existing.driver,
        },
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
      throw new BadRequestException('Integration has no credential bundle configured.');
    }
    let secret: Record<string, unknown>;
    try {
      const json = this.crypto.decrypt(row.secret.ciphertext, integrationSecretAad(row.id));
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
    validateResourceRegistry(driver.descriptor, this.writers);
    for (const r of driver.descriptor.resources) {
      await this.prisma.integrationResource.upsert({
        where: {
          integrationId_resourceKey: { integrationId, resourceKey: r.key },
        },
        create: {
          integrationId,
          resourceKey: r.key,
          enabled: r.defaultEnabled ?? true,
          targetKind: r.targetKind,
          targetConfig: r.targetConfig as Prisma.InputJsonValue,
          dependsOnResourceKeys: r.dependsOnResourceKeys,
        },
        update: {
          targetKind: r.targetKind,
          targetConfig: r.targetConfig as Prisma.InputJsonValue,
          dependsOnResourceKeys: r.dependsOnResourceKeys,
        },
      });
      const recommendation = driver.recommendedDestinations?.[r.key];
      if (recommendation) {
        await ensureResourceDestination(this.prisma, integrationId, r.key, recommendation);
      }
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
    return this.sortResources(
      driver,
      rows.map((r) => this.toResourceDto(driver, r)),
    );
  }

  async getResource(integrationId: string, resourceKey: string): Promise<IntegrationResourceDto> {
    const integration = await this.requireIntegration(integrationId);
    const driver = this.drivers.get(integration.driver);
    this.assertResourceKey(driver.descriptor, resourceKey);
    const row = await this.findOrCreateResource(integrationId, resourceKey, driver.descriptor);
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
    const resourceDescriptor = driver.descriptor.resources.find(
      (resource) => resource.key === input.resourceKey,
    )!;
    await this.prisma.integrationResource.create({
      data: {
        integrationId,
        resourceKey: input.resourceKey,
        enabled: resourceDescriptor.defaultEnabled ?? true,
        targetKind: resourceDescriptor.targetKind,
        targetConfig: resourceDescriptor.targetConfig as Prisma.InputJsonValue,
        dependsOnResourceKeys: resourceDescriptor.dependsOnResourceKeys,
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
    const existing = await this.findOrCreateResource(integrationId, resourceKey, driver.descriptor);
    const fieldMappingCount = await this.prisma.integrationFieldMapping.count({
      where: { resourceId: existing.id },
    });
    const resourceDescriptor = driver.descriptor.resources.find(
      (resource) => resource.key === resourceKey,
    )!;
    assertResourcePatchCompatible(resourceDescriptor, input, existing.targetKind);
    const nextTargetConfig = validateResourceTargetConfig(
      resourceDescriptor,
      input.targetConfig ?? (existing.targetConfig as Record<string, unknown>),
    );

    const nextLayoutId =
      input.assetLayoutId === undefined ? existing.assetLayoutId : input.assetLayoutId;

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
      targetConfig: existing.targetConfig,
    };

    await this.prisma.integrationResource.update({
      where: { id: existing.id },
      data: {
        enabled: input.enabled ?? undefined,
        assetLayoutId:
          input.assetLayoutId === undefined ? undefined : (input.assetLayoutId ?? null),
        matchKeyFieldIds: input.matchKeyFieldIds === undefined ? undefined : input.matchKeyFieldIds,
        targetConfig: input.targetConfig === undefined
          ? undefined
          : (nextTargetConfig as Prisma.InputJsonValue),
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
        targetConfig: fresh.targetConfig,
      },
      fields: ['enabled', 'assetLayoutId', 'matchKeyFieldIds', 'targetConfig'],
    });
    return fresh;
  }

  // -------------------------------------------------------------------
  // Reconstruction completeness and safe gaps (global administration)
  // -------------------------------------------------------------------

  async getReconstructionCompleteness(
    integrationId: string,
    query: IntegrationCompletenessQuery,
  ): Promise<IntegrationCompletenessResponse> {
    const { integration, companyIds } =
      await this.requireReconstructionReadScope(integrationId, query);
    const rows = companyIds.length === 0
      ? []
      : await this.withReconstructionCompanyScope(companyIds, () =>
          this.prisma.integrationReconstructionSummary.findMany({
            where: {
              companyId: { in: companyIds },
              companyMapping: { integrationId },
              resource: { integrationId },
              // Cleared (non-participant) tombstones keep the evaluation clock
              // alive but are not scorecards.
              clearedAt: null,
              ...(query.mappingId ? { integrationCompanyMappingId: query.mappingId } : {}),
              ...(query.resourceId ? { resourceId: query.resourceId } : {}),
            },
            include: {
              company: { select: { name: true } },
              companyMapping: { select: { companyId: true, integrationId: true } },
              resource: { select: { resourceKey: true, integrationId: true } },
            },
            orderBy: [
              { integrationCompanyMappingId: 'asc' },
              { resourceId: 'asc' },
              { id: 'asc' },
            ],
            take: 10_001,
          }),
        );
    if (rows.length > 10_000) {
      throw new BadRequestException('Completeness results exceeded the bounded limit.');
    }
    const descriptor = this.drivers.has(integration.driver)
      ? this.drivers.describe(integration.driver)
      : null;
    const responseRows = rows.flatMap((row) => {
      if (!row.resourceId || !row.resource) return [];
      assertReconstructionRowScope(integrationId, row.companyId, row.companyMapping, row.resource);
      const counts = reconstructionCompletenessCountsSchema.parse(row.counts);
      return [{
        id: row.id,
        companyId: row.companyId,
        companyName: row.company.name,
        integrationCompanyMappingId: row.integrationCompanyMappingId,
        resourceId: row.resourceId,
        resourceKey: row.resource.resourceKey,
        resourceLabel: descriptor?.resources.find((resource) => resource.key === row.resource!.resourceKey)?.label
          ?? row.resource.resourceKey,
        counts,
        evaluatedAt: row.evaluatedAt.toISOString(),
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
      }];
    });
    const totals = emptyCompletenessCounts();
    for (const row of responseRows) addCompletenessCounts(totals, row.counts);
    return integrationCompletenessResponseSchema.parse({ counts: totals, rows: responseRows });
  }

  async listReconstructionGaps(
    integrationId: string,
    query: IntegrationGapsQuery,
  ): Promise<IntegrationGapsPage> {
    const { integration, companyIds } =
      await this.requireReconstructionReadScope(integrationId, query);
    const cursor = query.cursor
      ? decodeGapCursor(query.cursor, integrationId, query, this.env.integrationActiveKey)
      : null;
    const snapshotAt = cursor?.snapshotAt ?? new Date();
    const resolutionWhere = query.resolution === 'active'
      ? { resolvedAt: null }
      : query.resolution === 'resolved'
        ? { resolvedAt: { not: null } }
        : {};
    const read = () => this.prisma.integrationReconstructionGap.findMany({
      where: {
        companyId: { in: companyIds },
        companyMapping: { integrationId },
        resource: { integrationId },
        createdAt: { lte: snapshotAt },
        ...(query.mappingId ? { integrationCompanyMappingId: query.mappingId } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...resolutionWhere,
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
        } : {}),
      },
      include: {
        company: { select: { name: true } },
        companyMapping: { select: { companyId: true, integrationId: true } },
        resource: { select: { resourceKey: true, integrationId: true } },
        syncRecord: {
          select: {
            companyId: true, integrationCompanyMappingId: true, resourceId: true,
            targetKind: true,
            assetId: true, subnetId: true, ipReservationId: true, articleId: true, relationId: true,
            asset: { select: { name: true, companyId: true } },
            subnet: { select: { name: true, companyId: true } },
            ipReservation: {
              select: {
                label: true, subnetId: true, companyId: true,
                subnet: { select: { companyId: true } },
              },
            },
            article: { select: { title: true, companyId: true } },
            relation: { select: { companyId: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    const rows = companyIds.length === 0
      ? []
      : await this.withReconstructionCompanyScope(companyIds, read);
    for (const row of rows) {
      assertReconstructionRowScope(integrationId, row.companyId, row.companyMapping, row.resource);
    }
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const descriptor = this.drivers.has(integration.driver)
      ? this.drivers.describe(integration.driver)
      : null;
    const items = pageRows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      companyName: row.company.name,
      integrationCompanyMappingId: row.integrationCompanyMappingId,
      resourceId: row.resourceId,
      resourceKey: row.resource.resourceKey,
      resourceLabel: descriptor?.resources.find((resource) => resource.key === row.resource.resourceKey)?.label
        ?? row.resource.resourceKey,
      kind: row.kind,
      message: safeReadGapMessage(row.kind, row.message),
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      target: safeGapTarget({
        companyId: row.companyId,
        mappingId: row.integrationCompanyMappingId,
        resourceId: row.resourceId,
      }, row.syncRecord),
    }));
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last
      ? encodeGapCursor(
        { id: last.id, createdAt: last.createdAt },
        snapshotAt,
        integrationId,
        query,
        this.env.integrationActiveKey,
      )
      : null;
    return integrationGapsPageSchema.parse({ items, nextCursor });
  }

  private async requireReconstructionReadScope(
    integrationId: string,
    query: { mappingId?: string; resourceId?: string },
  ) {
    // Integration administration is globally authorized by
    // `integration.manage`. Resolve only mapping ids + company ids through
    // that global parent so the tenant-scoped read below can carry an exact,
    // integration-bound company allow-list.
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: {
        id: true,
        driver: true,
        companyMappings: {
          // The unfiltered branch enumerates every mapped company — the
          // scope predicate needs the explicit id list, so its IN clause
          // is bounded by the integration's mapping count.
          ...(query.mappingId ? { where: { id: query.mappingId } } : {}),
          select: { id: true, companyId: true },
        },
      },
    });
    if (!integration) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }
    const selectedMapping = query.mappingId
      ? integration.companyMappings.find((mapping) => mapping.id === query.mappingId)
      : null;
    if (query.mappingId && !selectedMapping) {
      throw new NotFoundException('Integration mapping not found');
    }
    if (query.resourceId) {
      const resource = await this.prisma.integrationResource.findFirst({
        where: { id: query.resourceId, integrationId },
        select: { id: true },
      });
      if (!resource) throw new NotFoundException('Integration resource not found');
    }
    const companyIds = selectedMapping
      ? [selectedMapping.companyId]
      : [...new Set(integration.companyMappings.map((mapping) => mapping.companyId))];
    return { integration, companyIds };
  }

  private withReconstructionCompanyScope<T>(
    companyIds: string[],
    read: () => Promise<T>,
  ): Promise<T> {
    const tenant = getTenantContext();
    if (!tenant) return read();
    return runWithTenantContext(
      { ...tenant, allowedCompanyIds: companyIds },
      read,
    );
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
    const resource = await this.findOrCreateResource(integrationId, resourceKey, driver.descriptor);
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
      targetPath: r.targetPath,
      targetFieldName: r.targetField?.name ?? null,
      targetFieldSlug: r.targetField?.slug ?? null,
      targetFieldType: r.targetField?.fieldType ?? null,
      syncDirection: r.syncDirection,
      transform: (r.transform ?? null) as IntegrationFieldMappingDto['transform'],
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
    const resource = await this.findOrCreateResource(integrationId, resourceKey, driver.descriptor);
    if (!resource.assetLayoutId) {
      throw new BadRequestException(
        'Pick a target asset layout before configuring field mappings.',
      );
    }

    const assetMappings = input.mappings.map((mapping) => {
      if (!mapping.targetFieldId || mapping.targetPath) {
        throw new BadRequestException(
          'Asset resources require targetFieldId and cannot use targetPath.',
        );
      }
      return { ...mapping, targetFieldId: mapping.targetFieldId };
    });

    const seenSource = new Set<string>();
    const seenTarget = new Set<string>();
    for (const m of assetMappings) {
      const norm = m.sourceField.trim().toLowerCase();
      if (seenSource.has(norm)) {
        throw new BadRequestException(`Source field "${m.sourceField}" is mapped twice.`);
      }
      if (seenTarget.has(m.targetFieldId)) {
        throw new BadRequestException(
          'A target field is mapped more than once (only one source field may write to a target).',
        );
      }
      seenSource.add(norm);
      seenTarget.add(m.targetFieldId);
    }
    if (assetMappings.length > 0) {
      const valid = await this.prisma.assetField.findMany({
        where: {
          id: { in: assetMappings.map((m) => m.targetFieldId) },
          assetLayoutId: resource.assetLayoutId,
          archivedAt: null,
        },
        select: { id: true },
      });
      const validSet = new Set(valid.map((v) => v.id));
      for (const m of assetMappings) {
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
      if (assetMappings.length > 0) {
        await tx.integrationFieldMapping.createMany({
          data: assetMappings.map((m) => ({
            resourceId: resource.id,
            sourceField: m.sourceField.trim(),
            targetKind: 'asset',
            targetFieldId: m.targetFieldId,
            syncDirection: m.syncDirection,
            transform: m.transform ? (m.transform as Prisma.InputJsonValue) : Prisma.JsonNull,
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
    descriptor: DriverDescriptor,
  ) {
    const existing = await this.prisma.integrationResource.findUnique({
      where: { integrationId_resourceKey: { integrationId, resourceKey } },
      include: {
        assetLayout: { select: { name: true } },
        _count: { select: { fieldMappings: true } },
      },
    });
    if (existing) return existing;
    const resourceDescriptor = descriptor.resources.find(
      (resource) => resource.key === resourceKey,
    );
    if (!resourceDescriptor) {
      throw new BadRequestException(
        `Driver "${descriptor.key}" does not declare a resource named "${resourceKey}".`,
      );
    }
    return this.prisma.integrationResource.create({
      data: {
        integrationId,
        resourceKey,
        enabled: resourceDescriptor.defaultEnabled ?? true,
        targetKind: resourceDescriptor.targetKind,
        targetConfig: resourceDescriptor.targetConfig as Prisma.InputJsonValue,
        dependsOnResourceKeys: resourceDescriptor.dependsOnResourceKeys,
      },
      include: {
        assetLayout: { select: { name: true } },
        _count: { select: { fieldMappings: true } },
      },
    });
  }

  private assertResourceKey(descriptor: DriverDescriptor, resourceKey: string): void {
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
      throw new BadRequestException(`Asset layout ${assetLayoutId} is archived or inactive.`);
    }
  }

  private async assertMatchKeysOnLayout(assetLayoutId: string, fieldIds: string[]): Promise<void> {
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

  private validateDriverConfiguration(
    driverKey: string,
    config: Record<string, unknown> | null | undefined,
    secret: Record<string, unknown> | null | undefined,
  ): void {
    if (this.drivers.kindOf(driverKey) !== 'pull') return;
    this.drivers.get(driverKey).validateConfiguration?.(config, secret);
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
    const descriptor = driver.descriptor.resources.find((r) => r.key === row.resourceKey);
    return {
      id: row.id,
      integrationId: row.integrationId,
      resourceKey: row.resourceKey,
      resourceLabel: descriptor?.label ?? row.resourceKey,
      enabled: row.enabled,
      targetKind: row.targetKind,
      targetConfig: row.targetConfig as Record<string, unknown>,
      dependsOnResourceKeys: row.dependsOnResourceKeys,
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
    const order = new Map(driver.descriptor.resources.map((r, i) => [r.key, i] as const));
    return [...rows].sort(
      (a, b) =>
        (order.get(a.resourceKey) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.resourceKey) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  private toDto(row: IntegrationRowWithIncludes): IntegrationDto {
    const descriptor = this.drivers.has(row.driver) ? this.drivers.describe(row.driver) : null;
    const descriptorResources: DriverResourceDescriptor[] = descriptor?.resources ?? [];
    const driverShim = {
      descriptor: {
        ...(descriptor ?? {}),
        resources: descriptorResources,
      } as DriverDescriptor,
    };

    let secretMask: Record<string, string> | null = null;
    if (row.secret) {
      try {
        const json = this.crypto.decrypt(row.secret.ciphertext, integrationSecretAad(row.id));
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
    const defaultCron = rawDefault.toLowerCase() === 'off' ? null : rawDefault;
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

export function validateResourceRegistry(
  descriptor: DriverDescriptor,
  writers: Pick<ReconstructionWriterRegistry, 'has'>,
): void {
  const resources = new Map(descriptor.resources.map((resource) => [resource.key, resource]));
  for (const resource of descriptor.resources) {
    if (!writers.has(resource.targetKind)) {
      throw new BadRequestException(
        `No reconstruction writer is registered for target ${resource.targetKind}.`,
      );
    }
    for (const dependency of resource.dependsOnResourceKeys) {
      if (!resources.has(dependency)) {
        throw new BadRequestException(
          `Resource ${resource.key} has missing dependency ${dependency}.`,
        );
      }
    }
    if (resource.targetKind === 'asset' && resource.targetConfig.bindingResourceKey) {
      const binding = resources.get(resource.targetConfig.bindingResourceKey);
      if (!binding || binding.targetKind !== 'asset') {
        throw new BadRequestException(
          `bindingResourceKey ${resource.targetConfig.bindingResourceKey} must reference an asset resource.`,
        );
      }
      if (!resource.dependsOnResourceKeys.includes(resource.targetConfig.bindingResourceKey)) {
        throw new BadRequestException(
          `bindingResourceKey ${resource.targetConfig.bindingResourceKey} must be listed in dependsOnResourceKeys.`,
        );
      }
    }
  }
  buildDescriptorStages(descriptor.resources);
}

export function validateResourceTargetConfig(
  descriptor: DriverResourceDescriptor,
  targetConfig: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = driverResourceDescriptorSchema.safeParse({
    ...descriptor,
    targetKind: descriptor.targetKind,
    targetConfig,
  });
  if (!parsed.success) {
    throw new BadRequestException({
      error: 'ValidationError',
      message: 'Invalid target configuration for this resource kind.',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const mutableKeys = descriptor.targetKind === 'article'
    ? new Set(['folderSlug', 'visibility', 'template'])
    : descriptor.targetKind === 'relation'
      ? new Set(['typeMapping'])
      : new Set<string>();
  const descriptorTargetConfig = descriptor.targetConfig as Record<string, unknown>;
  const parsedTargetConfig = parsed.data.targetConfig as Record<string, unknown>;
  for (const [key, parsedValue] of Object.entries(parsedTargetConfig)) {
    if (!mutableKeys.has(key) && (
      !Object.hasOwn(descriptorTargetConfig, key) ||
      JSON.stringify(parsedValue) !== JSON.stringify(descriptorTargetConfig[key])
    )) {
      throw new BadRequestException(
        `Target configuration field "${key}" is descriptor-owned and cannot be changed.`,
      );
    }
  }
  for (const [key, descriptorValue] of Object.entries(descriptorTargetConfig)) {
    if (!mutableKeys.has(key) && !Object.hasOwn(parsedTargetConfig, key)) {
      throw new BadRequestException(
        `Target configuration field "${key}" is descriptor-owned and cannot be changed.`,
      );
    }
    if (!mutableKeys.has(key) && JSON.stringify(parsedTargetConfig[key]) !== JSON.stringify(descriptorValue)) {
      throw new BadRequestException(
        `Target configuration field "${key}" is descriptor-owned and cannot be changed.`,
      );
    }
  }
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(descriptorTargetConfig)) {
    if (!mutableKeys.has(key)) validated[key] = value;
  }
  for (const [key, value] of Object.entries(parsedTargetConfig)) {
    if (mutableKeys.has(key)) validated[key] = value;
  }
  return validated;
}

export function assertResourcePatchCompatible(
  descriptor: Pick<DriverResourceDescriptor, 'targetKind'>,
  input: Pick<UpdateIntegrationResourceInput, 'assetLayoutId' | 'matchKeyFieldIds'>,
  persistedTargetKind: string = descriptor.targetKind,
): void {
  if (persistedTargetKind !== descriptor.targetKind) {
    throw new BadRequestException(
      'Persisted resource target kind does not match the immutable driver descriptor.',
    );
  }
  if (
    descriptor.targetKind !== 'asset' &&
    (input.assetLayoutId !== undefined || input.matchKeyFieldIds !== undefined)
  ) {
    throw new BadRequestException(
      'Asset layout and match-key controls are available only for asset resources.',
    );
  }
}

function buildDescriptorStages(resources: readonly DriverResourceDescriptor[]): void {
  const pending = new Map(resources.map((resource) => [resource.key, resource]));
  const completed = new Set<string>();
  while (pending.size > 0) {
    const ready = resources.filter(
      (resource) =>
        pending.has(resource.key) &&
        resource.dependsOnResourceKeys.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) {
      throw new BadRequestException('Resource dependency graph contains a cycle.');
    }
    for (const resource of ready) {
      pending.delete(resource.key);
      completed.add(resource.key);
    }
  }
}

type CompletenessCountsValue = {
  synchronizedCurrent: number;
  manuallyDocumented: number;
  secretBlocked: number;
  missing: number;
  stale: number;
  synchronizationError: number;
};

function emptyCompletenessCounts(): CompletenessCountsValue {
  return {
    synchronizedCurrent: 0,
    manuallyDocumented: 0,
    secretBlocked: 0,
    missing: 0,
    stale: 0,
    synchronizationError: 0,
  };
}

function addCompletenessCounts(target: CompletenessCountsValue, source: CompletenessCountsValue): void {
  for (const key of Object.keys(target) as Array<keyof CompletenessCountsValue>) {
    target[key] += source[key];
  }
}

function assertReconstructionRowScope(
  integrationId: string,
  companyId: string,
  companyMapping: { companyId: string; integrationId: string },
  resource: { integrationId: string },
): void {
  if (
    companyMapping.integrationId !== integrationId ||
    resource.integrationId !== integrationId ||
    companyMapping.companyId !== companyId
  ) {
    throw new BadRequestException('Inconsistent reconstruction scope.');
  }
}

type GapCursorPayload = {
  v: 2;
  id: string;
  createdAt: string;
  snapshotAt: string;
  scope: string;
};

function gapCursorScope(
  integrationId: string,
  query: Pick<IntegrationGapsQuery, 'mappingId' | 'resourceId' | 'kind' | 'resolution'>,
): string {
  return JSON.stringify({
    integrationId,
    mappingId: query.mappingId ?? null,
    resourceId: query.resourceId ?? null,
    kind: query.kind ?? null,
    resolution: query.resolution,
  });
}

function encodeGapCursor(
  row: { id: string; createdAt: Date },
  snapshotAt: Date,
  integrationId: string,
  query: IntegrationGapsQuery,
  key: Buffer,
): string {
  const payload: GapCursorPayload = {
    v: 2,
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    snapshotAt: snapshotAt.toISOString(),
    scope: gapCursorScope(integrationId, query),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key)
    .update('weavestream-integration-gap-cursor-v2\0')
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function decodeGapCursor(
  cursor: string,
  integrationId: string,
  query: IntegrationGapsQuery,
  key: Buffer,
): { id: string; createdAt: Date; snapshotAt: Date } {
  try {
    const [encoded, suppliedSignature, extra] = cursor.split('.');
    if (!encoded || !suppliedSignature || extra !== undefined) throw new Error('shape');
    const expectedSignature = createHmac('sha256', key)
      .update('weavestream-integration-gap-cursor-v2\0')
      .update(encoded)
      .digest();
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) {
      throw new Error('signature');
    }
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<GapCursorPayload>;
    if (
      payload.v !== 2 ||
      typeof payload.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.id) ||
      payload.scope !== gapCursorScope(integrationId, query) ||
      typeof payload.createdAt !== 'string' ||
      typeof payload.snapshotAt !== 'string'
    ) throw new Error('payload');
    const createdAt = new Date(payload.createdAt);
    const snapshotAt = new Date(payload.snapshotAt);
    if (
      !Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== payload.createdAt ||
      !Number.isFinite(snapshotAt.getTime()) || snapshotAt.toISOString() !== payload.snapshotAt ||
      createdAt > snapshotAt
    ) {
      throw new Error('date');
    }
    return { id: payload.id, createdAt, snapshotAt };
  } catch {
    throw new BadRequestException('Invalid or mismatched reconstruction gap cursor.');
  }
}

function safeReadGapMessage(kind: string, message: string): string {
  return message.length <= 512 && scanSensitiveMaterial(message) === 'safe'
    ? message
    : `A ${kind.replaceAll('_', ' ')} item requires operator review.`;
}

function safeGapTarget(
  scope: { companyId: string; mappingId: string; resourceId: string },
  record: {
    companyId: string;
    integrationCompanyMappingId: string;
    resourceId: string;
    targetKind: string;
    assetId: string | null;
    subnetId: string | null;
    ipReservationId: string | null;
    articleId: string | null;
    relationId: string | null;
    asset: { name: string; companyId: string } | null;
    subnet: { name: string; companyId: string } | null;
    ipReservation: {
      label: string;
      subnetId: string;
      companyId: string;
      subnet: { companyId: string };
    } | null;
    article: { title: string; companyId: string } | null;
    relation: { companyId: string } | null;
  } | null,
): IntegrationNativeTarget | null {
  if (
    !record ||
    record.companyId !== scope.companyId ||
    record.integrationCompanyMappingId !== scope.mappingId ||
    record.resourceId !== scope.resourceId
  ) return null;
  const companyId = scope.companyId;
  switch (record.targetKind) {
    case 'asset':
      return record.assetId && record.asset?.companyId === companyId ? {
        targetKind: 'asset', targetId: record.assetId, targetLabel: record.asset.name,
        targetHref: `/admin/companies/${companyId}/assets/${record.assetId}`,
      } : null;
    case 'subnet':
      return record.subnetId && record.subnet?.companyId === companyId ? {
        targetKind: 'subnet', targetId: record.subnetId, targetLabel: record.subnet.name,
        targetHref: `/admin/companies/${companyId}/ipam/${record.subnetId}`,
      } : null;
    case 'ip_reservation':
      return record.ipReservationId &&
        record.ipReservation?.companyId === companyId &&
        record.ipReservation.subnet.companyId === companyId ? {
        targetKind: 'ip_reservation', targetId: record.ipReservationId,
        targetLabel: record.ipReservation.label,
        targetHref: `/admin/companies/${companyId}/ipam/${record.ipReservation.subnetId}`,
      } : null;
    case 'article':
      return record.articleId && record.article?.companyId === companyId ? {
        targetKind: 'article', targetId: record.articleId, targetLabel: record.article.title,
        targetHref: `/admin/companies/${companyId}/articles/${record.articleId}`,
      } : null;
    case 'relation':
      return record.relationId && record.relation?.companyId === companyId ? {
        targetKind: 'relation', targetId: record.relationId,
        targetLabel: 'Relationship', targetHref: null,
      } : null;
    default:
      return null;
  }
}

interface ResourceRowWithIncludes {
  id: string;
  integrationId: string;
  resourceKey: string;
  enabled: boolean;
  targetKind: 'asset' | 'subnet' | 'ip_reservation' | 'article' | 'relation';
  targetConfig: unknown;
  dependsOnResourceKeys: string[];
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
