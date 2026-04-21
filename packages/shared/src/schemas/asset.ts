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
