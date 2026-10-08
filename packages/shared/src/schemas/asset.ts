import { z } from 'zod';
import { FieldTypeValues } from './field-types.js';
import { integrationTargetProvenanceSchema } from './integration.js';
import { actorRefSchema } from './user.js';

/**
 * Dynamic Asset DTOs. The *exact* per-field value shape is not known at
 * compile time (layouts are data), so the top-level schema accepts a
 * free-form `fieldValues` record keyed by field slug. The API enriches
 * this with `buildAssetZodSchema(layout, role)` at request time to
 * validate every value against its `FieldTypeStrategy.valueSchema(opts)`.
 *
 * Each value is one of: string, number, boolean, null, array of primitives,
 * or a composite object (RICH_TEXT / FILE / ASSET_REFERENCE / TAGS). The
 * runtime validator enforces the actual shape per type.
 */

export const fieldValuePrimitiveSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(fieldValuePrimitiveSchema),
    z.record(fieldValuePrimitiveSchema),
  ]),
);

export const fieldValuesSchema = z.record(fieldValuePrimitiveSchema);
export type FieldValues = z.infer<typeof fieldValuesSchema>;

export const createAssetSchema = z.object({
  assetLayoutId: z.string().uuid(),
  /**
   * Optional override for `Asset.name`. If absent the service derives it
   * from the layout's primary field value — matching the "primary · will
   * become the asset name" hint in the form mock.
   */
  name: z.string().min(1).max(200).optional(),
  externalId: z.string().min(1).max(200).optional(),
  externalSource: z.string().min(1).max(80).optional(),
  fieldValues: fieldValuesSchema.default({}),
});

export const updateAssetSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    externalId: z.string().min(1).max(200).nullable().optional(),
    externalSource: z.string().min(1).max(80).nullable().optional(),
    fieldValues: fieldValuesSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

/**
 * Bulk asset action request body. Used by the
 * `POST /companies/:companyId/assets/bulk/{archive|restore|purge}` endpoints.
 *
 * The cap of 500 is a guardrail against accidental "select all then delete"
 * actions that would generate hundreds of audit log entries and pile DB load
 * onto a single request. UI-side limits should mirror this.
 */
export const bulkAssetIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export type BulkAssetIdsInput = z.infer<typeof bulkAssetIdsSchema>;

/**
 * Copy an asset into a company (the same one, or another). Layouts are
 * global, so the copy keeps its layout. `archiveOriginal` turns the copy
 * into a move: the source is archived (recoverable), never purged.
 */
export const cloneAssetSchema = z
  .object({
    targetCompanyId: z.string().uuid(),
    archiveOriginal: z.boolean().default(false),
  })
  .strict();

export type CloneAssetInput = z.infer<typeof cloneAssetSchema>;

export const bulkCloneAssetsSchema = cloneAssetSchema.extend({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export type BulkCloneAssetsInput = z.infer<typeof bulkCloneAssetsSchema>;

/**
 * Per-item failure descriptor returned from a bulk asset action. `code` is a
 * machine-readable tag the UI can branch on (e.g. `not_archived`, `not_found`,
 * `forbidden`); `reason` is the user-facing message.
 */
export const bulkAssetFailureSchema = z.object({
  id: z.string().uuid(),
  reason: z.string(),
  code: z.string().optional(),
});

export type BulkAssetFailure = z.infer<typeof bulkAssetFailureSchema>;

/**
 * Result of a bulk asset action. The endpoint returns 200 even on partial
 * failure — the client decides how to surface the mix of `ok` and `failed`
 * (e.g. "Archived 8 of 10. 2 failed.").
 */
export const bulkAssetResultSchema = z.object({
  ok: z.array(z.string().uuid()),
  failed: z.array(bulkAssetFailureSchema),
});

export type BulkAssetResult = z.infer<typeof bulkAssetResultSchema>;

// ---------------------------------------------------------------------
// Response contracts — the wire shape `GET /companies/:id/assets` (list
// rows) and `GET /companies/:id/assets/:assetId` (detail) both return.
// Dates are ISO strings. The API keeps its own `Date`-typed
// `SerializedAsset`; a contract test there checks that its JSON form
// matches these.
// ---------------------------------------------------------------------

/** One layout field as embedded on an asset, for rendering its values. */
export const assetFieldMetaSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  fieldType: z.enum(FieldTypeValues),
  isPrimary: z.boolean(),
  visibleToClients: z.boolean(),
  options: z.record(z.unknown()),
});

/**
 * Phase 11.2 — one `IntegrationSyncRecord` linked to an asset. One asset
 * can be claimed by several integrations at once (e.g. an Action1
 * endpoint and a UniFi client for the same machine), so clients show all
 * of them rather than only the "primary" one on `externalSource`.
 */
export const assetSyncSourceSchema = z.object({
  integrationId: z.string().uuid(),
  integrationName: z.string(),
  driver: z.string(),
  resourceKey: z.string(),
  lastSyncedAt: z.string(),
});

/** Server-resolved label for one ASSET_REFERENCE target. */
export const assetReferenceEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  archivedAt: z.string().nullable(),
});

export const assetSummarySchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  assetLayoutId: z.string().uuid(),
  layoutName: z.string(),
  layoutSlug: z.string(),
  layoutIcon: z.string(),
  layoutColor: z.string(),
  name: z.string(),
  externalId: z.string().nullable(),
  externalSource: z.string().nullable(),
  /**
   * Phase 11 — last time an integration successfully wrote to this
   * asset. Null for manually-created or untouched assets. Populated by
   * the API's `hydrateSyncMetadata` helper based on the matching
   * `IntegrationSyncRecord` row.
   */
  lastSyncedAt: z.string().nullable(),
  /**
   * Layout-field ids that were last touched by the integration sync.
   * Used by the edit form to render a subtle "synced" indicator next
   * to fields the operator may want to leave alone (or knowingly
   * override). Empty for manual assets.
   */
  syncedFieldIds: z.array(z.string()),
  /** Empty array for manual assets. */
  syncSources: z.array(assetSyncSourceSchema),
  /** Always `[]` on list rows; populated on detail. */
  provenance: z.array(integrationTargetProvenanceSchema),
  archivedAt: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  updatedBy: z.string().uuid().nullable(),
  createdByUser: actorRefSchema.nullable(),
  updatedByUser: actorRefSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Keyed by field slug; visibility-filtered per role server-side. */
  fieldValues: z.record(z.unknown()),
  fields: z.array(assetFieldMetaSchema),
  /**
   * Server-resolved labels for ASSET_REFERENCE values, keyed by the
   * referenced asset id. The list + detail endpoints populate this with
   * a single batched lookup so tables and detail views can render the
   * target asset's name instead of a bare uuid. Missing entries = the
   * referent was hard-deleted or is out of scope.
   */
  references: z.record(assetReferenceEntrySchema),
  /** True if the signed-in user has starred this asset (detail only). */
  isStarred: z.boolean(),
});

export const assetPageSchema = z.object({
  items: z.array(assetSummarySchema),
  nextCursor: z.string().nullable(),
});

export type AssetFieldMeta = z.infer<typeof assetFieldMetaSchema>;
export type AssetSyncSource = z.infer<typeof assetSyncSourceSchema>;
export type AssetReferenceEntry = z.infer<typeof assetReferenceEntrySchema>;
export type AssetSummary = z.infer<typeof assetSummarySchema>;
export type AssetPage = z.infer<typeof assetPageSchema>;
