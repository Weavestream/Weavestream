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
export type IntegrationSyncDirectionValue = z.infer<
  typeof integrationSyncDirectionSchema
>;

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
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
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
export const driverResourceDescriptorSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  /**
   * Free-text hint shown in the UI when the operator first enables the
   * resource (e.g. the natural match-key field). Purely informational
   * — the driver does not enforce it.
   */
  defaultMatchKeyHint: z.string().nullable().optional(),
});

export type DriverResourceDescriptor = z.infer<
  typeof driverResourceDescriptorSchema
>;

export const driverDescriptorSchema = z.object({
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
  }),
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
  assetLayoutId: z.string().uuid().nullable(),
  assetLayoutName: z.string().nullable(),
  matchKeyFieldIds: z.array(z.string().uuid()),
  /** Snapshot of total field mappings configured for this resource. */
  fieldMappingCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type IntegrationResourceDto = z.infer<
  typeof integrationResourceDtoSchema
>;

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

export type CreateIntegrationResourceInput = z.infer<
  typeof createIntegrationResourceSchema
>;
export type UpdateIntegrationResourceInput = z.infer<
  typeof updateIntegrationResourceSchema
>;

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

export type IntegrationCompanyMappingDto = z.infer<
  typeof integrationCompanyMappingDtoSchema
>;

// ---------------------------------------------------------------------
// Field-mapping CRUD (GLOBAL — one row per (integration, sourceField))
// ---------------------------------------------------------------------

export const fieldMappingDraftSchema = z.object({
  sourceField: z.string().min(1),
  targetFieldId: z.string().uuid(),
  syncDirection: integrationSyncDirectionSchema.default('source_wins'),
  transform: z.record(z.unknown()).nullable().optional(),
});

export const replaceFieldMappingsSchema = z.object({
  mappings: z.array(fieldMappingDraftSchema),
});

export type FieldMappingDraft = z.infer<typeof fieldMappingDraftSchema>;
export type ReplaceFieldMappingsInput = z.infer<
  typeof replaceFieldMappingsSchema
>;

export const integrationFieldMappingDtoSchema = z.object({
  id: z.string().uuid(),
  /** Phase 11.1 — scoped per resource (devices vs clients vs records). */
  resourceId: z.string().uuid(),
  resourceKey: z.string(),
  sourceField: z.string(),
  targetFieldId: z.string().uuid(),
  targetFieldSlug: z.string().nullable(),
  targetFieldName: z.string().nullable(),
  targetFieldType: z.string().nullable(),
  syncDirection: integrationSyncDirectionSchema,
  transform: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type IntegrationFieldMappingDto = z.infer<
  typeof integrationFieldMappingDtoSchema
>;

// ---------------------------------------------------------------------
// Sync run history
// ---------------------------------------------------------------------

export const triggerSyncSchema = z.object({
  dryRun: z.boolean().default(false),
});

export type TriggerSyncInput = z.infer<typeof triggerSyncSchema>;

export const integrationSyncRunDtoSchema = z.object({
  id: z.string().uuid(),
  integrationId: z.string().uuid(),
  kind: integrationRunKindSchema,
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
  errors: z.number().int().nonnegative().default(0),
} as const;

export const syncRunResourceTotalsSchema = z.object(baseSyncRunTotalsShape);
export type SyncRunResourceTotals = z.infer<
  typeof syncRunResourceTotalsSchema
>;

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
  kind: z.enum([
    'ambiguous_match',
    'manual_skip',
    'validation_error',
    'driver_error',
  ]),
  externalId: z.string(),
  /** Free-form summary line for the run viewer. */
  message: z.string(),
  /** Up to ~5 conflicting asset ids surfaced for the operator to triage. */
  candidateAssetIds: z.array(z.string().uuid()).optional(),
});

export type SyncRunConflict = z.infer<typeof syncRunConflictSchema>;
