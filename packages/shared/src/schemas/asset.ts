import { z } from 'zod';

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
