import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { SyncRunConflict, SyncRunTotals } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { SearchIndexService } from '../search/search-index.service.js';
import { EnvService } from '../config/env.service.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import {
  MatchResolverService,
  type MatchResolution,
} from './match-resolver.service.js';
import {
  DriverAuthError,
  DriverRateLimitError,
  type DriverFetchPage,
  type DriverRecord,
  type FetchRecordsContext,
} from './drivers/integration-driver.js';

/**
 * Phase 11 — per-mapping sync execution.
 *
 * Driven by the worker's mapping processor (one BullMQ job per
 * (run, mapping)). The runner:
 *   1. Loads the mapping + integration + decoded driver context.
 *   2. Pages the driver until exhaustion.
 *   3. For each record:
 *      a. Asks `MatchResolverService` what to do.
 *      b. Creates / claims / updates / records-conflict accordingly.
 *      c. Writes the per-field values respecting `syncDirection`
 *         (`source_wins` overwrites, `preserve_manual` skips fields the
 *         operator edited since the last sync, `manual_only` is never
 *         touched and stripped from the projected set).
 *   4. Optionally archives any sync-record whose externalId disappeared
 *      from the source (only when the driver returned a complete page —
 *      otherwise the run could prune live records).
 *
 * SUPER_ADMIN-impersonating tenant context — set per record so the
 * Prisma tenant-scope middleware enforces the per-row companyId
 * filter (writes only land in the mapping's company).
 */

const SYSTEM_AUDIT_USER_AGENT = 'weavestream-worker/integration-sync';

export interface MappingRunInput {
  syncRunId: string;
  integrationCompanyMappingId: string;
  dryRun: boolean;
  /** Triggered-by user id for audit attribution; null on scheduled runs. */
  actorId: string | null;
}

export interface MappingRunOutcome {
  status: 'succeeded' | 'failed';
  totals: SyncRunTotals;
  conflicts: SyncRunConflict[];
  error: string | null;
  companyId: string;
}

@Injectable()
export class IntegrationSyncRunnerService {
  private readonly logger = new Logger(IntegrationSyncRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly fieldTypes: FieldTypesRegistry,
    private readonly searchIndex: SearchIndexService,
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly matchResolver: MatchResolverService,
  ) {}

  async runMapping(input: MappingRunInput): Promise<MappingRunOutcome> {
    const totals: SyncRunTotals = emptyTotals();
    const conflicts: SyncRunConflict[] = [];

    const mapping = await this.prisma.integrationCompanyMapping.findUnique({
      where: { id: input.integrationCompanyMappingId },
      include: {
        integration: {
          include: {
            // Field mappings, target layout, and match-key fields all
            // live on the parent Integration after the global-mapping
            // refactor (D-021). Loading them here once means every
            // per-company mapping job projects through the same
            // schema — no risk of per-tenant drift.
            fieldMappings: {
              include: {
                targetField: {
                  select: {
                    id: true,
                    slug: true,
                    fieldType: true,
                    options: true,
                    archivedAt: true,
                  },
                },
              },
            },
            assetLayout: {
              include: {
                fields: { orderBy: { position: 'asc' } },
              },
            },
          },
        },
      },
    });
    if (!mapping) {
      throw new NotFoundException(
        `IntegrationCompanyMapping ${input.integrationCompanyMappingId} not found`,
      );
    }
    if (!mapping.integration.assetLayoutId || !mapping.integration.assetLayout) {
      throw new BadRequestException(
        `Integration ${mapping.integrationId} has no asset layout configured.`,
      );
    }
    if (mapping.integration.fieldMappings.length === 0) {
      throw new BadRequestException(
        `Integration ${mapping.integrationId} has no field mappings configured.`,
      );
    }

    const companyId = mapping.companyId;
    const assetLayoutId = mapping.integration.assetLayoutId;
    const matchKeyFieldIds = mapping.integration.matchKeyFieldIds;

    // The worker runs outside a request context — Prisma's tenant
    // middleware sees `getTenantContext() === undefined` and bypasses
    // its check (CLI/system path). Every write below carries an
    // explicit `companyId` so cross-tenant leakage is impossible.

    const driver = this.drivers.get(mapping.integration.driver);
    const ctx = await this.integrations.loadDriverContext(mapping.integrationId);

    const fetchCtx: FetchRecordsContext = {
      config: ctx.config,
      secret: ctx.secret,
      http: {
        timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
        maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
        backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
      },
      correlationId: randomUUID(),
      externalOrgId: mapping.externalOrgId,
      filter: (mapping.filter ?? {}) as Record<string, unknown>,
    };

    const writableMappings = mapping.integration.fieldMappings
      .filter((m) => m.targetField.archivedAt === null)
      .filter((m) => m.syncDirection !== 'manual_only');

    // Fingerprint of the projection config — included in every
    // per-record checksum so a mapping change (re-pick of source key,
    // direction flip, target re-bind) invalidates the "unchanged"
    // fast-path and forces every record to be re-projected on the
    // next run. Without this, fixing a wrong-case source key only
    // takes effect when Action1 *also* mutates the upstream record
    // (which can be days/weeks).
    const mappingFingerprint = computeMappingFingerprint(writableMappings);

    const seenExternalIds = new Set<string>();
    // Track which mapped source keys ever resolved to a non-null/non-
    // empty value. Source fields that stay empty across an ENTIRE run
    // are almost always a misconfiguration (wrong-case key, renamed
    // upstream column) — silently nulling the target on every record
    // would be very surprising. We surface a `validation_error`
    // conflict at the end of the run for each such field so it shows
    // up in the run viewer instead of staying invisible.
    const sourceFieldHits = new Map<string, number>();
    for (const fm of writableMappings) sourceFieldHits.set(fm.sourceField, 0);

    let cursor: string | null = null;
    let pageCount = 0;
    try {
      while (true) {
        const page: DriverFetchPage = await driver.fetchRecords(
          fetchCtx,
          cursor,
        );
        pageCount += 1;
        for (const record of page.records) {
          totals.fetched += 1;
          seenExternalIds.add(record.externalId);
          for (const fm of writableMappings) {
            const v = record.fields[fm.sourceField];
            if (v !== null && v !== undefined && v !== '') {
              sourceFieldHits.set(
                fm.sourceField,
                (sourceFieldHits.get(fm.sourceField) ?? 0) + 1,
              );
            }
          }
          try {
            await this.processRecord({
              mapping: {
                id: mapping.id,
                companyId,
                integrationId: mapping.integrationId,
                integrationDriver: mapping.integration.driver,
                assetLayoutId,
                matchKeyFieldIds,
              },
              syncRunId: input.syncRunId,
              dryRun: input.dryRun,
              actorId: input.actorId,
              record,
              writableMappings,
              mappingFingerprint,
              totals,
              conflicts,
            });
          } catch (e) {
            totals.errors += 1;
            const message = e instanceof Error ? e.message : String(e);
            conflicts.push({
              kind:
                e instanceof DriverAuthError ||
                e instanceof DriverRateLimitError
                  ? 'driver_error'
                  : 'validation_error',
              externalId: record.externalId,
              message: message.slice(0, 500),
            });
            this.logger.warn(
              {
                err: message,
                mappingId: mapping.id,
                externalId: record.externalId,
              },
              'integration-sync: record failed',
            );
            if (
              e instanceof DriverAuthError ||
              e instanceof DriverRateLimitError
            ) {
              throw e;
            }
          }
        }
        if (!page.hasMore || pageCount >= 1_000) break;
        cursor = page.cursor;
      }

      // Optional: prune external records that disappeared from the source.
      // Only safe when we walked every page (not in dry run).
      if (!input.dryRun) {
        await this.archiveDisappearedRecords({
          mappingId: mapping.id,
          companyId,
          integrationDriver: mapping.integration.driver,
          seenExternalIds,
          totals,
          actorId: input.actorId,
        });
      }

      // Surface mapped source keys that never produced a value. We
      // require at least one record to have been fetched (otherwise
      // an empty org would always trip the warning).
      if (totals.fetched > 0) {
        for (const [sourceField, hits] of sourceFieldHits) {
          if (hits > 0) continue;
          const targetSlug = writableMappings.find(
            (m) => m.sourceField === sourceField,
          )?.targetField.slug;
          conflicts.push({
            kind: 'validation_error',
            externalId: '',
            message:
              `Source field "${sourceField}" had no value on any of the ${totals.fetched} ` +
              `record(s) returned by the driver. The mapping to "${targetSlug ?? 'unknown'}" ` +
              `would have written NULL on every record. Likely a wrong-case key — check ` +
              `the field-mappings dropdown for the correct upstream key.`,
          });
        }
      }

      return {
        status: 'succeeded',
        totals,
        conflicts,
        error: null,
        companyId,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      conflicts.push({
        kind: 'driver_error',
        externalId: '',
        message: message.slice(0, 500),
      });
      return {
        status: 'failed',
        totals,
        conflicts,
        error: message.slice(0, 4_000),
        companyId,
      };
    }
  }

  // -------------------------------------------------------------------
  // Per-record pipeline
  // -------------------------------------------------------------------

  private async processRecord(args: {
    mapping: {
      id: string;
      companyId: string;
      integrationId: string;
      integrationDriver: string;
      assetLayoutId: string;
      matchKeyFieldIds: string[];
    };
    syncRunId: string;
    dryRun: boolean;
    actorId: string | null;
    record: DriverRecord;
    writableMappings: Array<{
      sourceField: string;
      syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
      targetField: {
        id: string;
        slug: string;
        fieldType: string;
        options: unknown;
      };
    }>;
    mappingFingerprint: string;
    totals: SyncRunTotals;
    conflicts: SyncRunConflict[];
  }): Promise<void> {
    const projected = this.projectFields({
      record: args.record,
      writableMappings: args.writableMappings,
    });

    const resolution = await this.matchResolver.resolve({
      companyId: args.mapping.companyId,
      integrationCompanyMappingId: args.mapping.id,
      integrationDriver: args.mapping.integrationDriver,
      externalId: args.record.externalId,
      source: args.record.fields,
      fieldMappings: args.writableMappings.map((m) => ({
        sourceField: m.sourceField,
        targetField: m.targetField,
      })),
      matchKeyFieldIds: args.mapping.matchKeyFieldIds,
    });

    if (resolution.kind === 'ambiguous') {
      args.totals.skippedAmbiguous += 1;
      args.conflicts.push({
        kind: 'ambiguous_match',
        externalId: args.record.externalId,
        message: `Multiple unclaimed assets matched the configured match-key fields.`,
        candidateAssetIds: resolution.candidateAssetIds,
      });
      if (!args.dryRun) {
        await this.audit.log({
          actorId: args.actorId,
          action: AUDIT_ACTIONS.integration.matchAmbiguous,
          entityType: 'IntegrationCompanyMapping',
          entityId: args.mapping.id,
          companyId: args.mapping.companyId,
          ip: '0.0.0.0',
          userAgent: SYSTEM_AUDIT_USER_AGENT,
          before: null,
          after: {
            externalId: args.record.externalId,
            candidateAssetIds: resolution.candidateAssetIds,
          },
        });
      }
      return;
    }

    if (args.dryRun) {
      // Count an outcome bucket for the run viewer but write nothing.
      switch (resolution.kind) {
        case 'create':
          args.totals.created += 1;
          break;
        case 'claim':
          args.totals.claimed += 1;
          break;
        case 'reuse':
          args.totals.unchanged += 1;
          break;
      }
      return;
    }

    await this.applyResolution({
      mapping: args.mapping,
      syncRunId: args.syncRunId,
      record: args.record,
      projected,
      writableMappings: args.writableMappings,
      mappingFingerprint: args.mappingFingerprint,
      resolution,
      totals: args.totals,
      actorId: args.actorId,
    });
  }

  private async applyResolution(args: {
    mapping: {
      id: string;
      companyId: string;
      integrationDriver: string;
      assetLayoutId: string;
    };
    syncRunId: string;
    record: DriverRecord;
    projected: ProjectedFields;
    writableMappings: Array<{
      sourceField: string;
      syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
      targetField: {
        id: string;
        slug: string;
        fieldType: string;
        options: unknown;
      };
    }>;
    mappingFingerprint: string;
    resolution: MatchResolution;
    totals: SyncRunTotals;
    actorId: string | null;
  }): Promise<void> {
    const recordChecksum = computeRecordChecksum(
      args.record,
      args.mappingFingerprint,
    );

    if (args.resolution.kind === 'reuse') {
      const sync = await this.prisma.integrationSyncRecord.findUnique({
        where: {
          integrationCompanyMappingId_externalId: {
            integrationCompanyMappingId: args.mapping.id,
            externalId: args.record.externalId,
          },
        },
      });
      if (sync && sync.checksum === recordChecksum) {
        args.totals.unchanged += 1;
        await this.prisma.integrationSyncRecord.update({
          where: { id: sync.id },
          data: { lastSyncedAt: new Date(), syncRunId: args.syncRunId },
        });
        return;
      }
      await this.prisma.$transaction(async (tx) => {
        const writeResult = await this.writeFieldValues({
          tx,
          assetId: args.resolution.kind === 'reuse' ? args.resolution.assetId : '',
          companyId: args.mapping.companyId,
          projected: args.projected,
          writableMappings: args.writableMappings,
          previousChecksums: (sync?.lastSyncedFieldChecksums ?? {}) as Record<
            string,
            string
          >,
          totals: args.totals,
        });
        await tx.asset.updateMany({
          where: {
            id: args.resolution.kind === 'reuse' ? args.resolution.assetId : '',
            companyId: args.mapping.companyId,
          },
          data: {
            externalId: args.record.externalId,
            externalSource: args.mapping.integrationDriver,
            ...(args.record.displayName ? { name: args.record.displayName } : {}),
          },
        });
        await tx.integrationSyncRecord.upsert({
          where: {
            integrationCompanyMappingId_externalId: {
              integrationCompanyMappingId: args.mapping.id,
              externalId: args.record.externalId,
            },
          },
          create: {
            integrationCompanyMappingId: args.mapping.id,
            assetId: args.resolution.kind === 'reuse' ? args.resolution.assetId : '',
            companyId: args.mapping.companyId,
            externalId: args.record.externalId,
            lastSyncedAt: new Date(),
            checksum: recordChecksum,
            lastSyncedFieldChecksums: writeResult.fieldChecksums,
            syncRunId: args.syncRunId,
          },
          update: {
            lastSyncedAt: new Date(),
            checksum: recordChecksum,
            lastSyncedFieldChecksums: writeResult.fieldChecksums,
            syncRunId: args.syncRunId,
          },
        });
        if (args.resolution.kind === 'reuse') {
          await this.searchIndex.upsertAsset(tx, args.resolution.assetId);
        }
      });
      args.totals.updated += 1;
      await this.audit.log({
        actorId: args.actorId,
        action: AUDIT_ACTIONS.integration.assetUpdated,
        entityType: 'Asset',
        entityId:
          args.resolution.kind === 'reuse' ? args.resolution.assetId : null,
        companyId: args.mapping.companyId,
        ip: '0.0.0.0',
        userAgent: SYSTEM_AUDIT_USER_AGENT,
        before: null,
        after: {
          externalId: args.record.externalId,
          mappingId: args.mapping.id,
        },
      });
      return;
    }

    if (args.resolution.kind === 'claim') {
      await this.prisma.$transaction(async (tx) => {
        const writeResult = await this.writeFieldValues({
          tx,
          assetId: args.resolution.kind === 'claim' ? args.resolution.assetId : '',
          companyId: args.mapping.companyId,
          projected: args.projected,
          writableMappings: args.writableMappings,
          previousChecksums: {},
          totals: args.totals,
        });
        await tx.asset.updateMany({
          where: {
            id: args.resolution.kind === 'claim' ? args.resolution.assetId : '',
            companyId: args.mapping.companyId,
          },
          data: {
            externalId: args.record.externalId,
            externalSource: args.mapping.integrationDriver,
            ...(args.record.displayName ? { name: args.record.displayName } : {}),
          },
        });
        await tx.integrationSyncRecord.create({
          data: {
            integrationCompanyMappingId: args.mapping.id,
            assetId: args.resolution.kind === 'claim' ? args.resolution.assetId : '',
            companyId: args.mapping.companyId,
            externalId: args.record.externalId,
            lastSyncedAt: new Date(),
            checksum: recordChecksum,
            lastSyncedFieldChecksums: writeResult.fieldChecksums,
            syncRunId: args.syncRunId,
          },
        });
        if (args.resolution.kind === 'claim') {
          await this.searchIndex.upsertAsset(tx, args.resolution.assetId);
        }
      });
      args.totals.claimed += 1;
      await this.audit.log({
        actorId: args.actorId,
        action: AUDIT_ACTIONS.integration.assetClaimed,
        entityType: 'Asset',
        entityId:
          args.resolution.kind === 'claim' ? args.resolution.assetId : null,
        companyId: args.mapping.companyId,
        ip: '0.0.0.0',
        userAgent: SYSTEM_AUDIT_USER_AGENT,
        before: null,
        after: {
          externalId: args.record.externalId,
          mappingId: args.mapping.id,
        },
      });
      return;
    }

    // create
    const newAssetId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({
        data: {
          companyId: args.mapping.companyId,
          assetLayoutId: args.mapping.assetLayoutId,
          name: args.record.displayName ?? `External ${args.record.externalId}`,
          externalId: args.record.externalId,
          externalSource: args.mapping.integrationDriver,
        },
      });
      const writeResult = await this.writeFieldValues({
        tx,
        assetId: created.id,
        companyId: args.mapping.companyId,
        projected: args.projected,
        writableMappings: args.writableMappings,
        previousChecksums: {},
        totals: args.totals,
      });
      await tx.integrationSyncRecord.create({
        data: {
          integrationCompanyMappingId: args.mapping.id,
          assetId: created.id,
          companyId: args.mapping.companyId,
          externalId: args.record.externalId,
          lastSyncedAt: new Date(),
          checksum: recordChecksum,
          lastSyncedFieldChecksums: writeResult.fieldChecksums,
          syncRunId: args.syncRunId,
        },
      });
      await this.searchIndex.upsertAsset(tx, created.id);
      return created.id;
    });
    args.totals.created += 1;
    await this.audit.log({
      actorId: args.actorId,
      action: AUDIT_ACTIONS.integration.assetCreated,
      entityType: 'Asset',
      entityId: newAssetId,
      companyId: args.mapping.companyId,
      ip: '0.0.0.0',
      userAgent: SYSTEM_AUDIT_USER_AGENT,
      before: null,
      after: {
        externalId: args.record.externalId,
        mappingId: args.mapping.id,
      },
    });
  }

  /**
   * Project source fields onto target fields and normalise the values.
   * Source values that don't pass the field strategy's validator are
   * dropped (with a debug log) — the run still succeeds for the rest of
   * the record. Strict-mode validation would punish a single bad column
   * in an otherwise healthy record.
   */
  private projectFields(args: {
    record: DriverRecord;
    writableMappings: Array<{
      sourceField: string;
      syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
      targetField: {
        id: string;
        slug: string;
        fieldType: string;
        options: unknown;
      };
    }>;
  }): ProjectedFields {
    const out: ProjectedFields = {};
    for (const fm of args.writableMappings) {
      // Distinguish "key missing" from "key present, value cleared":
      //   - `key not in fields`         → skip this field entirely. The
      //     local value stays as-is. This is the safety net for
      //     wrong-case mappings (`os` instead of `OS`) so we never
      //     silently nuke perfectly good local data.
      //   - `fields[key] === null/''`   → propagate null (operator
      //     intentionally cleared the upstream value).
      if (!Object.prototype.hasOwnProperty.call(args.record.fields, fm.sourceField)) {
        continue;
      }
      const raw = args.record.fields[fm.sourceField];
      if (raw === null || raw === undefined || raw === '') {
        out[fm.targetField.id] = {
          fieldId: fm.targetField.id,
          slug: fm.targetField.slug,
          syncDirection: fm.syncDirection,
          value: null,
        };
        continue;
      }
      try {
        const strategy = this.fieldTypes.get(fm.targetField.fieldType as never);
        const opts = (fm.targetField.options ?? {}) as Record<string, unknown>;
        const normalised = strategy.normalize(raw, opts);

        // Defense-in-depth: drivers occasionally surface values that pass
        // the strategy's coercion (e.g. a flattened multi-NIC RMM string
        // "10.0.0.35, 10.0.0.50" mapped to an IP_ADDRESS field) but would
        // never round-trip through `valueSchema`. Re-validate so invalid
        // shapes never reach the DB and break downstream typed queries
        // (Phase 6 search, IPAM containment, etc.).
        if (normalised !== null && normalised !== undefined) {
          const parsed = strategy.valueSchema(opts).safeParse(normalised);
          if (!parsed.success) {
            this.logger.debug(
              {
                sourceField: fm.sourceField,
                targetSlug: fm.targetField.slug,
                fieldType: fm.targetField.fieldType,
                issues: parsed.error.issues.map((i) => i.message),
              },
              'projectFields: dropping value that failed valueSchema',
            );
            continue;
          }
        }

        out[fm.targetField.id] = {
          fieldId: fm.targetField.id,
          slug: fm.targetField.slug,
          syncDirection: fm.syncDirection,
          value: normalised as unknown,
        };
      } catch (err) {
        this.logger.debug(
          {
            err: (err as Error).message,
            sourceField: fm.sourceField,
            targetSlug: fm.targetField.slug,
          },
          'projectFields: dropping value that failed strategy.normalize',
        );
      }
    }
    return out;
  }

  /**
   * Persist projected values onto the asset's `AssetFieldValue` rows,
   * honouring `syncDirection`:
   *   - source_wins      → always overwrite.
   *   - preserve_manual  → if the stored value's checksum doesn't match
   *                        what we wrote last time AND it's non-null,
   *                        skip the field (operator edited it).
   */
  private async writeFieldValues(args: {
    tx: Prisma.TransactionClient;
    assetId: string;
    companyId: string;
    projected: ProjectedFields;
    writableMappings: Array<{
      syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
      targetField: { id: string };
    }>;
    previousChecksums: Record<string, string>;
    totals: SyncRunTotals;
  }): Promise<{ fieldChecksums: Record<string, string> }> {
    const fieldChecksums: Record<string, string> = {};

    let existingValuesById: Map<string, unknown> | null = null;
    const needsExisting = Object.values(args.projected).some(
      (p) => p.syncDirection === 'preserve_manual',
    );
    if (needsExisting) {
      const rows = await args.tx.assetFieldValue.findMany({
        where: { assetId: args.assetId, companyId: args.companyId },
        select: { assetFieldId: true, value: true },
      });
      existingValuesById = new Map(rows.map((r) => [r.assetFieldId, r.value]));
    }

    for (const proj of Object.values(args.projected)) {
      const checksum = computeValueChecksum(proj.value);

      if (proj.syncDirection === 'preserve_manual') {
        const stored = existingValuesById?.get(proj.fieldId) ?? null;
        const lastChecksum = args.previousChecksums[proj.fieldId];
        const storedChecksum = computeValueChecksum(stored);
        const wasManuallyEdited =
          stored !== null &&
          stored !== undefined &&
          lastChecksum !== undefined &&
          lastChecksum !== storedChecksum;
        if (wasManuallyEdited) {
          args.totals.skippedManual += 1;
          fieldChecksums[proj.fieldId] = storedChecksum;
          continue;
        }
      }

      if (proj.value === null || proj.value === undefined) {
        await args.tx.assetFieldValue.deleteMany({
          where: {
            assetId: args.assetId,
            assetFieldId: proj.fieldId,
            companyId: args.companyId,
          },
        });
      } else {
        await args.tx.assetFieldValue.upsert({
          where: {
            assetId_assetFieldId: {
              assetId: args.assetId,
              assetFieldId: proj.fieldId,
            },
          },
          create: {
            companyId: args.companyId,
            assetId: args.assetId,
            assetFieldId: proj.fieldId,
            value: proj.value as Prisma.InputJsonValue,
          },
          update: {
            companyId: args.companyId,
            value: proj.value as Prisma.InputJsonValue,
          },
        });
      }
      fieldChecksums[proj.fieldId] = checksum;
    }

    return { fieldChecksums };
  }

  /**
   * After walking all pages, archive every sync record whose externalId
   * was NOT seen this run. We don't HARD-archive the asset; we clear
   * its `externalId` / `externalSource` and delete the sync record so
   * the asset persists for the operator with no upstream linkage.
   *
   * This honours the explicit "deleting an integration must never
   * delete an asset" contract — a missing record on the upstream is
   * treated the same as a deleted integration.
   */
  private async archiveDisappearedRecords(args: {
    mappingId: string;
    companyId: string;
    integrationDriver: string;
    seenExternalIds: Set<string>;
    totals: SyncRunTotals;
    actorId: string | null;
  }): Promise<void> {
    const stale = await this.prisma.integrationSyncRecord.findMany({
      where: { integrationCompanyMappingId: args.mappingId },
      select: { id: true, assetId: true, externalId: true },
    });
    const disappeared = stale.filter(
      (s) => !args.seenExternalIds.has(s.externalId),
    );
    if (disappeared.length === 0) return;

    const assetIds = disappeared.map((s) => s.assetId);
    await this.prisma.$transaction(async (tx) => {
      await tx.integrationSyncRecord.deleteMany({
        where: { id: { in: disappeared.map((d) => d.id) } },
      });
      await tx.asset.updateMany({
        where: { id: { in: assetIds }, companyId: args.companyId },
        data: { externalId: null, externalSource: null },
      });
    });
    args.totals.archived += disappeared.length;
    for (const s of disappeared) {
      await this.audit.log({
        actorId: args.actorId,
        action: AUDIT_ACTIONS.integration.assetReleased,
        entityType: 'Asset',
        entityId: s.assetId,
        companyId: args.companyId,
        ip: '0.0.0.0',
        userAgent: SYSTEM_AUDIT_USER_AGENT,
        before: { externalSource: args.integrationDriver, externalId: s.externalId },
        after: { externalSource: null, externalId: null },
      });
    }
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface ProjectedFieldEntry {
  fieldId: string;
  slug: string;
  syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
  value: unknown;
}
type ProjectedFields = Record<string, ProjectedFieldEntry>;

function emptyTotals(): SyncRunTotals {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    claimed: 0,
    archived: 0,
    skippedAmbiguous: 0,
    skippedManual: 0,
    errors: 0,
  };
}

function computeRecordChecksum(
  record: DriverRecord,
  mappingFingerprint: string,
): string {
  // Fold the mapping fingerprint into the canonical form so changing
  // the field-mapping config invalidates every cached `IntegrationSyncRecord.checksum`
  // — otherwise the runner takes the "unchanged" fast-path and never
  // re-projects values when only the mapping (not the upstream
  // record) changed.
  const canonical = JSON.stringify({
    externalId: record.externalId,
    displayName: record.displayName ?? null,
    fields: sortedJson(record.fields),
    mappingFingerprint,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Stable hash of the projection config — source key, target field,
 * and direction for every writable mapping. Order-independent so a
 * cosmetic re-order doesn't blow the cache, but any semantic change
 * does.
 */
function computeMappingFingerprint(
  writableMappings: ReadonlyArray<{
    sourceField: string;
    syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
    targetField: { id: string };
  }>,
): string {
  const rows = writableMappings
    .map((m) => ({
      sourceField: m.sourceField,
      targetFieldId: m.targetField.id,
      syncDirection: m.syncDirection,
    }))
    .sort((a, b) => {
      if (a.sourceField !== b.sourceField) {
        return a.sourceField.localeCompare(b.sourceField);
      }
      return a.targetFieldId.localeCompare(b.targetFieldId);
    });
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function computeValueChecksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortedJson((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
