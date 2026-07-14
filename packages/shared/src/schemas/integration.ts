import { z } from 'zod';

/**
 * Phase 11 — universal integration framework schemas.
 *
 * The framework is GLOBAL: one `Integration` row drives many tenant
 * `IntegrationCompanyMapping` rows. Each schema in this file lives at
 * the boundary between the API and the admin UI / driver registry —
 * runtime validation happens in the controller (`ZodBody`) and at the
 * driver-registry edge.
 *
 * Driver-specific fields (`config`, `secret`) are validated as opaque
 * JSON here; the matching driver enforces its own shape before
 * encrypting / persisting.
 */

// ---------------------------------------------------------------------
// Enum mirrors (kept identical to Prisma)
// ---------------------------------------------------------------------

export const integrationStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'DISABLED']);
export type IntegrationStatusValue = z.infer<typeof integrationStatusSchema>;

export const integrationSyncDirectionSchema = z.enum([
  'source_wins',
  'preserve_manual',
  'manual_only',
]);
export type IntegrationSyncDirectionValue = z.infer<typeof integrationSyncDirectionSchema>;

export const integrationRunKindSchema = z.enum(['manual', 'scheduled']);
export type IntegrationRunKindValue = z.infer<typeof integrationRunKindSchema>;

export const integrationRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type IntegrationRunStatusValue = z.infer<typeof integrationRunStatusSchema>;

export const integrationTargetKindSchema = z.enum([
  'asset',
  'subnet',
  'ip_reservation',
  'article',
  'relation',
]);
export type IntegrationTargetKind = z.infer<typeof integrationTargetKindSchema>;

export const integrationSyncStateSchema = z.enum(['active', 'stale', 'blocked']);
export type IntegrationSyncState = z.infer<typeof integrationSyncStateSchema>;

export const integrationSyncModeSchema = z.enum(['incremental', 'full']);
export type IntegrationSyncMode = z.infer<typeof integrationSyncModeSchema>;

export const reconstructionGapKindSchema = z.enum([
  'secret_blocked',
  'missing_dependency',
  'validation',
  'unsupported',
  'ambiguous',
  'synchronization_error',
]);
export type ReconstructionGapKind = z.infer<typeof reconstructionGapKindSchema>;

/**
 * Approximate PostgreSQL JSONB text rendering for persistence byte limits.
 * PostgreSQL separates object keys/values and collection entries with one
 * space, so plain JSON.stringify would under-count the database CHECK value.
 */
const persistedJsonText = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(persistedJsonText).join(', ')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${JSON.stringify(key)}: ${persistedJsonText(entry)}`)
    .join(', ')}}`;
};

const persistedJsonByteLength = (value: unknown): number =>
  new TextEncoder().encode(persistedJsonText(value)).byteLength;

// ---------------------------------------------------------------------
// Driver descriptor (registry → admin UI)
// ---------------------------------------------------------------------
//
// `IntegrationDriverRegistry.list()` projects each driver onto this
// shape so the admin UI can render the credential / config / mapping
// editors generically — no hard-coded driver-aware screens.

export const driverFieldKindSchema = z.enum([
  'text',
  'password',
  'url',
  'number',
  'boolean',
  'select',
]);

export const driverFieldDescriptorSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: driverFieldKindSchema,
  required: z.boolean().default(false),
  description: z.string().nullable().optional(),
  /** Allowed `select` options. */
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  /** Driver-recommended default for booleans / selects / numbers. */
  default: z.unknown().optional(),
});

export type DriverFieldDescriptor = z.infer<typeof driverFieldDescriptorSchema>;

/**
 * Phase 11.1 — driver-declared resources.
 *
 * A driver advertises one or more "resources" it can sync. Each
 * resource maps to its own `IntegrationResource` row carrying a
 * distinct asset layout, match keys, and field mappings. Single-
 * resource drivers (Action1) declare a single `'records'` entry; the
 * UI still renders one resource tab so the editor stays uniform.
 */
const driverResourceKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const sourceEndpointSchema = z.string().min(1).max(256).startsWith('/');
const boundedTargetStringSchema = z.string().min(1).max(128);

const resourceDescriptorBaseShape = {
  key: driverResourceKeySchema,
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  /**
   * Free-text hint shown in the UI when the operator first enables the
   * resource (e.g. the natural match-key field). Purely informational
   * — the driver does not enforce it.
   */
  defaultMatchKeyHint: z.string().nullable().optional(),
  dependsOnResourceKeys: z.array(driverResourceKeySchema).max(64).default([]),
} as const;

const assetTargetConfigSchema = z
  .object({
    sourceEndpoint: sourceEndpointSchema.optional(),
    bindingResourceKey: driverResourceKeySchema.optional(),
  })
  .strict();
const subnetTargetConfigSchema = z
  .object({
    sourceEndpoint: sourceEndpointSchema.optional(),
    normalization: z.literal('cidr').optional(),
  })
  .strict();
const ipReservationTargetConfigSchema = z
  .object({
    sourceEndpoint: sourceEndpointSchema.optional(),
    normalization: z.literal('ip').optional(),
  })
  .strict();
const articleTargetConfigSchema = z
  .object({
    sourceEndpoint: sourceEndpointSchema.optional(),
    folderSlug: boundedTargetStringSchema.optional(),
    visibility: z.enum(['company', 'internal']).optional(),
    template: z.string().max(32_768).optional(),
  })
  .strict();
const relationTargetConfigSchema = z
  .object({
    sourceEndpoint: sourceEndpointSchema.optional(),
    typeMapping: z
      .record(boundedTargetStringSchema, boundedTargetStringSchema)
      .superRefine((mapping, ctx) => {
        if (Object.keys(mapping).length > 128) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'typeMapping may contain at most 128 entries',
});
        }
      })
      .optional(),
  })
  .strict();

const resourceDescriptorUnion = z.discriminatedUnion('targetKind', [
  z.object({
    ...resourceDescriptorBaseShape,
    targetKind: z.literal('asset'),
    targetConfig: assetTargetConfigSchema.default({}),
  }),
  z.object({
    ...resourceDescriptorBaseShape,
    targetKind: z.literal('subnet'),
    targetConfig: subnetTargetConfigSchema.default({}),
  }),
  z.object({
    ...resourceDescriptorBaseShape,
    targetKind: z.literal('ip_reservation'),
    targetConfig: ipReservationTargetConfigSchema.default({}),
  }),
  z.object({
    ...resourceDescriptorBaseShape,
    targetKind: z.literal('article'),
    targetConfig: articleTargetConfigSchema.default({}),
  }),
  z.object({
    ...resourceDescriptorBaseShape,
    targetKind: z.literal('relation'),
    targetConfig: relationTargetConfigSchema.default({}),
  }),
]);

export const driverResourceDescriptorSchema = z
  .preprocess((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const descriptor = input as Record<string, unknown>;
    return {
      ...descriptor,
      targetKind: descriptor['targetKind'] ?? 'asset',
      targetConfig: descriptor['targetConfig'] ?? {},
    };
  }, resourceDescriptorUnion)
  .superRefine((resource, ctx) => {
    if (persistedJsonByteLength(resource.targetConfig) > 32_768) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetConfig'],
        message: 'targetConfig must serialize to at most 32768 bytes',
      });
    }
    if (resource.dependsOnResourceKeys.includes(resource.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependsOnResourceKeys'],
        message: 'A resource cannot depend on itself',
      });
    }
    if (new Set(resource.dependsOnResourceKeys).size !== resource.dependsOnResourceKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependsOnResourceKeys'],
        message: 'Dependency keys must be unique',
      });
    }
  });

export type DriverResourceDescriptor = z.infer<typeof driverResourceDescriptorSchema>;

export const driverDescriptorSchema = z
  .object({
  /** Stable id used as `Integration.driver` and in registry lookups. */
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable(),
  /** SVG path key the UI should resolve from its icon set. */
  iconKey: z.string().nullable(),
  /** Editable `Integration.config` shape. */
  configFields: z.array(driverFieldDescriptorSchema),
  /** Editable `IntegrationSecret` shape (write-only, never returned). */
  secretFields: z.array(driverFieldDescriptorSchema),
  /**
   * Resources this driver knows how to fetch. Asset-import (`pull`) drivers
   * declare at least one resource; security drivers (e.g. Cloudflare)
   * carry an empty array — they don't sync records into Weavestream
   * Assets, so per-resource layouts and field mappings don't apply.
   */
  resources: z.array(driverResourceDescriptorSchema).default([]),
  /** Driver capabilities surfaced to the UI. */
  capabilities: z.object({
    /**
     * Distinguishes asset-import drivers from outbound/security drivers.
     * `pull` (default): driver pages records from the upstream system
     * and the framework projects them onto Asset rows. `security`:
     * driver manages an external resource where Weavestream is the
     * source of truth (e.g. Cloudflare IP lists).
     */
    kind: z.enum(['pull', 'security']).default('pull'),
    /** Driver can list source orgs to populate the matcher. */
    listSourceOrgs: z.boolean(),
    /** Driver supports `dryRun` semantics. */
    dryRun: z.boolean(),
    /**
     * Phase 12 — driver exposes a read-only ticketing surface
     * (`listTickets`, `getTicket`). When true the generic
     * `/v1/companies/:companyId/tickets` route surfaces a Tickets
     * sidebar entry for every company that has an active mapping for
     * this integration. Default false: a driver that does not
     * implement the optional ticket methods is silently skipped by
     * the dispatcher.
     */
    ticketing: z.boolean().default(false),
  }),
  })
  .superRefine((driver, ctx) => {
    const keys = driver.resources.map((resource) => resource.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resources'],
        message: 'Resource keys must be unique',
      });
      return;
    }

    const resourcesByKey = new Map(driver.resources.map((resource) => [resource.key, resource]));
    for (const [index, resource] of driver.resources.entries()) {
      for (const dependency of resource.dependsOnResourceKeys) {
        if (!resourcesByKey.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['resources', index, 'dependsOnResourceKeys'],
            message: `Unknown resource dependency: ${dependency}`,
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      const resource = resourcesByKey.get(key);
      for (const dependency of resource?.dependsOnResourceKeys ?? []) {
        if (resourcesByKey.has(dependency) && hasCycle(dependency)) return true;
      }
      visiting.delete(key);
      visited.add(key);
      return false;
    };
    if (keys.some(hasCycle)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resources'],
        message: 'Resource dependency graph contains a cycle',
      });
    }
});

export type DriverDescriptor = z.infer<typeof driverDescriptorSchema>;

// ---------------------------------------------------------------------
// Integration CRUD (global SUPER_ADMIN-only)
// ---------------------------------------------------------------------

export const createIntegrationSchema = z.object({
  driver: z.string().min(1),
  name: z.string().min(1).max(100),
  /** Driver-validated config blob (no secrets). */
  config: z.record(z.unknown()).default({}),
  /** Driver-validated secret blob — encrypted before persisting. */
  secret: z.record(z.unknown()).optional(),
  /** Optional 5-field cron expression. NULL disables scheduled syncs. */
  syncCron: z.string().nullable().optional(),
  status: integrationStatusSchema.default('PAUSED'),
});

export const updateIntegrationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    config: z.record(z.unknown()).optional(),
    /** Replace secret bundle. Omit to leave the existing ciphertext alone. */
    secret: z.record(z.unknown()).optional(),
    /** Set to `null` to wipe the stored secret. */
    clearSecret: z.boolean().optional(),
    syncCron: z.string().nullable().optional(),
    status: integrationStatusSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

/**
 * Phase 11.1 — per-resource configuration carried on an Integration.
 *
 * Every `(integration, resourceKey)` pair owns its own asset layout,
 * match-keys, and field mappings. Snapshotted onto the parent
 * `IntegrationDto.resources` array so the UI can render the per-
 * resource tabs without a second round-trip.
 */
export const integrationResourceDtoSchema = z.object({
  id: z.string().uuid(),
  integrationId: z.string().uuid(),
  resourceKey: z.string(),
  /** Driver-declared label (snapshotted from the descriptor). */
  resourceLabel: z.string(),
  enabled: z.boolean(),
  targetKind: integrationTargetKindSchema,
  targetConfig: z.record(z.unknown()),
  dependsOnResourceKeys: z.array(driverResourceKeySchema),
  assetLayoutId: z.string().uuid().nullable(),
  assetLayoutName: z.string().nullable(),
  matchKeyFieldIds: z.array(z.string().uuid()),
  /** Snapshot of total field mappings configured for this resource. */
  fieldMappingCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type IntegrationResourceDto = z.infer<typeof integrationResourceDtoSchema>;

export const createIntegrationResourceSchema = z.object({
  resourceKey: z.string().min(1),
});

export const updateIntegrationResourceSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Set to a UUID to attach a layout, or `null` to detach. Detaching while field mappings exist is rejected. */
    assetLayoutId: z.string().uuid().nullable().optional(),
    /** Replace-all set of match-key AssetField ids on the chosen layout. */
    matchKeyFieldIds: z.array(z.string().uuid()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type CreateIntegrationResourceInput = z.infer<typeof createIntegrationResourceSchema>;
export type UpdateIntegrationResourceInput = z.infer<typeof updateIntegrationResourceSchema>;

export const integrationDtoSchema = z.object({
  id: z.string().uuid(),
  driver: z.string(),
  name: z.string(),
  status: integrationStatusSchema,
  config: z.record(z.unknown()),
  syncCron: z.string().nullable(),
  /**
   * Cron actually in effect for this integration: the row's own
   * `syncCron` if set, otherwise the global `INTEGRATION_SYNC_DEFAULT_CRON`,
   * or `null` if the global default is disabled (`off`).
   */
  effectiveSyncCron: z.string().nullable(),
  hasSecret: z.boolean(),
  /** Last 4 chars of every secret value, by key — used for masked display. */
  secretMask: z.record(z.string()).nullable(),
  /**
   * Per-resource config snapshots. Always non-empty (the seed migration
   * + create flow guarantee at least one resource row exists per
   * integration). Single-resource drivers expose one entry; UniFi
   * exposes one per declared resource.
   */
  resources: z.array(integrationResourceDtoSchema),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Snapshot of total enabled mappings (cheap counter for the list). */
  mappingCount: z.number().int(),
});

export type IntegrationDto = z.infer<typeof integrationDtoSchema>;

// ---------------------------------------------------------------------
// Source-org listing (driver step 1)
// ---------------------------------------------------------------------

export const sourceOrgSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  /** Optional driver-rendered hint shown next to the row. */
  hint: z.string().nullable().optional(),
});

export type SourceOrgDto = z.infer<typeof sourceOrgSchema>;

// ---------------------------------------------------------------------
// Source-field listing (driver step 3)
// ---------------------------------------------------------------------

export const sourceFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** Most-likely Weavestream field type — drives the suggested target. */
  hintType: z
    .enum([
      'TEXT',
      'TEXTAREA',
      'NUMBER',
      'DATE',
      'DATETIME',
      'BOOLEAN',
      'EMAIL',
      'URL',
      'IP_ADDRESS',
      'TAGS',
    ])
    .nullable(),
  description: z.string().nullable().optional(),
  /** True when the driver guarantees a value is always present. */
  alwaysPresent: z.boolean().default(true),
});

export type SourceFieldDto = z.infer<typeof sourceFieldSchema>;

// ---------------------------------------------------------------------
// Company-mapping CRUD (tenant-scoped via the chosen company_id)
// ---------------------------------------------------------------------
//
// Per-company mappings carry ONLY the per-tenant fan-out info (which
// company, which upstream org, optional driver filter). Layout +
// match-key + field mappings live on the parent `Integration` and are
// shared across every per-company mapping for that integration.

export const createIntegrationCompanyMappingSchema = z.object({
  companyId: z.string().uuid(),
  externalOrgId: z.string().min(1),
  externalOrgName: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
  filter: z.record(z.unknown()).default({}),
});

export const updateIntegrationCompanyMappingSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    externalOrgName: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    filter: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type CreateIntegrationCompanyMappingInput = z.infer<
  typeof createIntegrationCompanyMappingSchema
>;
export type UpdateIntegrationCompanyMappingInput = z.infer<
  typeof updateIntegrationCompanyMappingSchema
>;

export const integrationCompanyMappingDtoSchema = z.object({
  id: z.string().uuid(),
  integrationId: z.string().uuid(),
  companyId: z.string().uuid(),
  companyName: z.string().nullable(),
  externalOrgId: z.string(),
  externalOrgName: z.string().nullable(),
  enabled: z.boolean(),
  filter: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type IntegrationCompanyMappingDto = z.infer<typeof integrationCompanyMappingDtoSchema>;

// ---------------------------------------------------------------------
// Field-mapping CRUD (GLOBAL — one row per (integration, sourceField))
// ---------------------------------------------------------------------

const transformOptionStringSchema = z.string().max(4096);
const transformPathSchema = z.string().min(1).max(4096);
const transformPathArraySchema = z.array(transformPathSchema).min(1).max(128);
const simpleTransformStep = <T extends string>(op: T) => z.object({ op: z.literal(op) }).strict();
const enumLookupMappingSchema = z
  .record(transformOptionStringSchema, transformOptionStringSchema)
  .superRefine((mapping, ctx) => {
    if (Object.keys(mapping).length > 128) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enum_lookup mapping may contain at most 128 entries',
      });
    }
  });
const enumLookupStepSchema = z
  .object({
    op: z.literal('enum_lookup'),
    mapping: enumLookupMappingSchema,
    fallback: transformOptionStringSchema.optional(),
  })
  .strict();

export const integrationTransformStepSchema = z.discriminatedUnion('op', [
  simpleTransformStep('trim'),
  simpleTransformStep('lowercase'),
  simpleTransformStep('uppercase'),
  simpleTransformStep('to_number'),
  z
    .object({
      op: z.literal('to_boolean'),
      truthy: z.array(transformOptionStringSchema).max(128).optional(),
      falsy: z.array(transformOptionStringSchema).max(128).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('to_date'),
      format: transformOptionStringSchema.optional(),
    })
    .strict(),
  enumLookupStepSchema,
  z.object({ op: z.literal('first_nonempty'), paths: transformPathArraySchema }).strict(),
  z
    .object({
      op: z.literal('join'),
      paths: transformPathArraySchema,
      separator: transformOptionStringSchema,
    })
    .strict(),
  z
    .object({ op: z.literal('format_bytes'), precision: z.number().int().min(0).max(6).optional() })
    .strict(),
  simpleTransformStep('normalize_cidr'),
  simpleTransformStep('normalize_ip'),
  z
    .object({
      op: z.literal('markdown_table'),
      columns: z
        .array(
          z
            .object({
              header: transformOptionStringSchema,
              path: transformPathSchema,
            })
            .strict(),
        )
        .min(1)
        .max(128),
    })
    .strict(),
]);
export type IntegrationTransformStep = z.infer<typeof integrationTransformStepSchema>;

export const integrationTransformSchema = z
  .object({
    steps: z.array(integrationTransformStepSchema).min(1).max(16),
  })
  .strict()
  .superRefine((transform, ctx) => {
    if (persistedJsonByteLength(transform) > 65_536) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'transform must serialize to at most 65536 bytes',
      });
    }
  });
export type IntegrationTransform = z.infer<typeof integrationTransformSchema>;

export const fieldMappingDraftSchema = z
  .object({
  sourceField: z.string().min(1),
    targetFieldId: z.string().uuid().nullable().optional(),
    targetPath: z.string().min(1).max(4096).nullable().optional(),
  syncDirection: integrationSyncDirectionSchema.default('source_wins'),
    transform: integrationTransformSchema.nullable().optional(),
  })
  .refine(
    (mapping) => Number(mapping.targetFieldId != null) + Number(mapping.targetPath != null) === 1,
    { message: 'Exactly one of targetFieldId or targetPath must be provided' },
  );

export const replaceFieldMappingsSchema = z.object({
  mappings: z.array(fieldMappingDraftSchema),
});

export type FieldMappingDraft = z.infer<typeof fieldMappingDraftSchema>;
export type ReplaceFieldMappingsInput = z.infer<typeof replaceFieldMappingsSchema>;

export const integrationFieldMappingDtoSchema = z.object({
  id: z.string().uuid(),
  /** Phase 11.1 — scoped per resource (devices vs clients vs records). */
  resourceId: z.string().uuid(),
  resourceKey: z.string(),
  sourceField: z.string(),
  targetFieldId: z.string().uuid().nullable(),
  targetPath: z.string().nullable(),
  targetFieldSlug: z.string().nullable(),
  targetFieldName: z.string().nullable(),
  targetFieldType: z.string().nullable(),
  syncDirection: integrationSyncDirectionSchema,
  transform: integrationTransformSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type IntegrationFieldMappingDto = z.infer<typeof integrationFieldMappingDtoSchema>;

// ---------------------------------------------------------------------
// Sync run history
// ---------------------------------------------------------------------

export const triggerSyncSchema = z.object({
  dryRun: z.boolean().default(false),
  mode: integrationSyncModeSchema.default('incremental'),
});

export type TriggerSyncInput = z.infer<typeof triggerSyncSchema>;

export const integrationSyncRunDtoSchema = z.object({
  id: z.string().uuid(),
  integrationId: z.string().uuid(),
  kind: integrationRunKindSchema,
  mode: integrationSyncModeSchema,
  status: integrationRunStatusSchema,
  dryRun: z.boolean(),
  triggeredBy: z.string().uuid().nullable(),
  /**
   * Resolved actor for the run. NULL when `triggeredBy` is null
   * (scheduled / system runs) or the user has been removed since
   * triggering. Hydrated server-side so the UI never shows raw UUIDs.
   */
  triggeredByUser: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      email: z.string(),
    })
    .nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  totals: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

export type IntegrationSyncRunDto = z.infer<typeof integrationSyncRunDtoSchema>;

export const integrationSyncRunCompanyResultDtoSchema = z.object({
  id: z.string().uuid(),
  syncRunId: z.string().uuid(),
  integrationCompanyMappingId: z.string().uuid(),
  companyId: z.string().uuid(),
  companyName: z.string().nullable(),
  status: integrationRunStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  totals: z.record(z.unknown()).nullable(),
  conflicts: z.array(z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

export type IntegrationSyncRunCompanyResultDto = z.infer<
  typeof integrationSyncRunCompanyResultDtoSchema
>;

// ---------------------------------------------------------------------
// Aggregate counters carried in `IntegrationSyncRunCompanyResult.totals`
// and rolled up into `IntegrationSyncRun.totals`. Co-located here so
// both worker (writer) and admin UI (reader) share the source of truth.
// ---------------------------------------------------------------------

const baseSyncRunTotalsShape = {
  fetched: z.number().int().nonnegative().default(0),
  created: z.number().int().nonnegative().default(0),
  updated: z.number().int().nonnegative().default(0),
  unchanged: z.number().int().nonnegative().default(0),
  claimed: z.number().int().nonnegative().default(0),
  archived: z.number().int().nonnegative().default(0),
  skippedAmbiguous: z.number().int().nonnegative().default(0),
  skippedManual: z.number().int().nonnegative().default(0),
  /**
   * Records that resolved to an existing Weavestream asset which has
   * been archived by an operator. The runner refuses to refresh
   * archived rows so the operator's archive intent is preserved —
   * the next run either picks up a Restore (and resumes updates) or
   * the row is purged and the next sync creates a fresh asset.
   */
  skippedArchived: z.number().int().nonnegative().default(0),
  stale: z.number().int().nonnegative().default(0),
  restored: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  secretBlocked: z.number().int().nonnegative().default(0),
  missingDependency: z.number().int().nonnegative().default(0),
  errors: z.number().int().nonnegative().default(0),
} as const;

export const syncRunResourceTotalsSchema = z.object({
  ...baseSyncRunTotalsShape,
  /** Internal mapping-job state used to make whole-DAG retries replacement-based. */
  status: z.enum(['succeeded', 'failed']).optional(),
});
export type SyncRunResourceTotals = z.infer<typeof syncRunResourceTotalsSchema>;

export const syncRunTotalsSchema = z.object({
  ...baseSyncRunTotalsShape,
  /**
   * Phase 11.1 — per-resource breakdown, keyed by `resourceKey`. The
   * top-level counters above are the sum across every resource the
   * mapping ran. Optional so legacy single-resource rows pre-migration
   * still parse.
   */
  byResource: z.record(syncRunResourceTotalsSchema).optional(),
});

export type SyncRunTotals = z.infer<typeof syncRunTotalsSchema>;

export const syncRunConflictSchema = z.object({
  kind: z.enum(['ambiguous_match', 'manual_skip', 'validation_error', 'driver_error']),
  externalId: z.string(),
  /** Free-form summary line for the run viewer. */
  message: z.string(),
  /** Up to ~5 conflicting asset ids surfaced for the operator to triage. */
  candidateAssetIds: z.array(z.string().uuid()).optional(),
});

export type SyncRunConflict = z.infer<typeof syncRunConflictSchema>;

export const integrationProvenanceSchema = z
  .object({
    integrationId: z.string().uuid(),
    externalOrgId: z.string().min(1).max(256),
    resourceKey: z.string().min(1).max(256),
    externalId: z.string().min(1).max(1024),
    sourceRevision: z.string().max(256).nullable(),
    sourceFingerprint: z.string().max(256).nullable(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    lastSyncedAt: z.string().datetime().nullable(),
    ownership: z.enum(['breeze', 'weavestream']),
    state: integrationSyncStateSchema,
  })
  .strict();
export type SafeIntegrationProvenance = z.infer<typeof integrationProvenanceSchema>;

const sensitiveGapKeyPattern =
  /(secret|password|passwd|token|apikey|authorization|credential|privatekey|rawpayload|rawbody|rawrequest|rawresponse)/;
const sensitiveGapValuePatterns = [
  /\b(?:bearer|basic)\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)=\S+/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:gh[pousr]_|xox[baprs]-|sk-(?:live-|test-)?)[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const containsSensitiveGapMetadata = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return sensitiveGapValuePatterns.some((pattern) => pattern.test(value));
  }
  if (Array.isArray(value)) {
    return value.some(containsSensitiveGapMetadata);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      return sensitiveGapKeyPattern.test(normalizedKey) || containsSensitiveGapMetadata(entry);
    });
  }
  return false;
};

const containsUndefinedGapMetadata = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(containsUndefinedGapMetadata);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsUndefinedGapMetadata);
  }
  return false;
};

const gapCodeSchema = z.string().min(1).max(128);
const gapIdentitySchema = z.string().min(1).max(512);
const allowlistedGapDetailsSchema = z
  .object({
    reasonCode: gapCodeSchema.optional(),
    fieldPaths: z.array(z.string().min(1).max(512)).max(64).optional(),
    dependencyResourceKey: driverResourceKeySchema.optional(),
    dependencyExternalId: gapIdentitySchema.optional(),
    validationCodes: z.array(gapCodeSchema).max(64).optional(),
    unsupportedCapability: gapCodeSchema.optional(),
    candidateCount: z.number().int().nonnegative().max(1_000_000).optional(),
    sourceResource: driverResourceKeySchema.optional(),
    sourceOrgId: z.string().min(1).max(256).optional(),
    sourceId: gapIdentitySchema.optional(),
    targetKind: integrationTargetKindSchema.optional(),
    targetId: gapIdentitySchema.optional(),
    statusCode: z.number().int().nonnegative().max(999).optional(),
    retryable: z.boolean().optional(),
    schemaVersion: z.number().int().min(1).max(65_535).optional(),
  })
  .strict()
  .superRefine((details, ctx) => {
    if (persistedJsonByteLength(details) > 4096) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'details must serialize to at most 4096 bytes',
      });
    }
  });

const boundedGapDetailsSchema = z
  .unknown()
  .superRefine((details, ctx) => {
    if (containsUndefinedGapMetadata(details)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'details must contain only JSON values',
      });
    }
    if (containsSensitiveGapMetadata(details)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'details must not contain sensitive keys or credential-like values',
      });
    }
  })
  .pipe(allowlistedGapDetailsSchema);

const reconstructionGapShape = {
  companyId: z.string().uuid(),
  integrationCompanyMappingId: z.string().uuid(),
  resourceId: z.string().uuid(),
  externalId: z.string().max(512).nullable(),
  kind: reconstructionGapKindSchema,
  message: z.string().min(1).max(512),
  details: boundedGapDetailsSchema,
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
} as const;

export const integrationReconstructionGapInputSchema = z.object(reconstructionGapShape).strict();
export type IntegrationReconstructionGapInput = z.infer<
  typeof integrationReconstructionGapInputSchema
>;

export const integrationReconstructionGapDtoSchema = z
  .object({ id: z.string().uuid(), ...reconstructionGapShape })
  .strict();
export type IntegrationReconstructionGapDto = z.infer<typeof integrationReconstructionGapDtoSchema>;
