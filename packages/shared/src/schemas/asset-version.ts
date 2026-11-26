import { z } from 'zod';
import { FieldTypeValues } from './field-types.js';

/**
 * Asset version history (migration 0098).
 *
 * A version is the FULL state of an asset after one change. Field values
 * are keyed by `AssetField.id`. `changedFields` holds field ids plus the
 * identity tokens below. Values are returned only for fields the caller
 * may read (hidden-from-client fields are stripped for CLIENT_USER); the
 * list endpoint never exposes anything the asset detail endpoint would
 * not.
 */
export const ASSET_VERSION_IDENTITY_FIELDS = ['name', 'externalId', 'externalSource'] as const;
export type AssetVersionIdentityField = (typeof ASSET_VERSION_IDENTITY_FIELDS)[number];

/**
 * The only identity token a restore may name. `externalId` /
 * `externalSource` are recorded and shown in history but are deliberately
 * NOT restorable: re-applying a historical integration identity could
 * hijack or collide with a live sync binding.
 */
export const ASSET_VERSION_RESTORABLE_TOKENS = ['name'] as const;

/** Pre-dedupe cap on a per-field restore request. */
export const ASSET_VERSION_RESTORE_MAX_FIELDS = 200;

/**
 * Body of `POST /assets/:id/versions/:version/restore`. `fields` omitted =
 * restore the whole version. Entries must be a field id or `name`
 * (never a slug or free text); duplicates collapse. The service
 * additionally requires every entry to exist on the chosen version.
 */
export const restoreAssetVersionSchema = z
  .object({
    fields: z
      .array(z.union([z.enum(ASSET_VERSION_RESTORABLE_TOKENS), z.guid()]))
      .min(1)
      .max(ASSET_VERSION_RESTORE_MAX_FIELDS)
      .transform((f) => Array.from(new Set(f)))
      .optional(),
  })
  .strict()
  .default({});
export type RestoreAssetVersionInput = z.infer<typeof restoreAssetVersionSchema>;

export const assetVersionFieldMetaSchema = z.object({
  id: z.guid(),
  name: z.string(),
  fieldType: z.enum(FieldTypeValues),
  /** Same as `AssetSummary.fields[].options`: lets the UI label choices. */
  options: z.record(z.string(), z.unknown()),
});
export type AssetVersionFieldMeta = z.infer<typeof assetVersionFieldMetaSchema>;

/** Page size bounds for `GET .../versions`. */
export const ASSET_VERSION_LIST_DEFAULT_LIMIT = 20;
export const ASSET_VERSION_LIST_MAX_LIMIT = 100;

/**
 * Query of `GET .../versions`: keyset pagination over the version number
 * (`cursor` = the last version of the previous page; the next page holds
 * strictly older versions).
 */
export const assetVersionListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ASSET_VERSION_LIST_MAX_LIMIT)
      .default(ASSET_VERSION_LIST_DEFAULT_LIMIT),
    cursor: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();
export type AssetVersionListQuery = z.infer<typeof assetVersionListQuerySchema>;

/**
 * One row of the (lightweight) version list: no captured values. For a
 * CLIENT_USER `changedBy` / `changedByName` are always null and
 * `changeReason` is only ever the generic `restore from vN` or null.
 */
export const assetVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  changedFields: z.array(z.string()),
  /** Null for integration/system writes, the lazy baseline, and client readers. */
  changedBy: z.guid().nullable(),
  changedByName: z.string().nullable(),
  changeReason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  /** True when an operator scrubbed values from this version. */
  redacted: z.boolean(),
});
export type AssetVersionSummary = z.infer<typeof assetVersionSummarySchema>;

export const assetVersionListSchema = z.object({
  /** The readable, non-archived fields of the asset's layout, for labels. */
  fields: z.array(assetVersionFieldMetaSchema),
  items: z.array(assetVersionSummarySchema),
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: z.number().int().nullable(),
});
export type AssetVersionList = z.infer<typeof assetVersionListSchema>;

/** The state of the asset as captured by one version (readable fields only). */
export const assetVersionStateSchema = z.object({
  name: z.string(),
  /** Keyed by field id; only fields the caller may read, only non-empty. */
  values: z.record(z.string(), z.unknown()),
  /** Readable field ids whose value was scrubbed from this version. */
  redactedFields: z.array(z.string()),
});

/**
 * `GET .../versions/:version`: the summary plus the captured values, and
 * the state of the previous version (for "was: ...") under the same
 * projection rules. `previous` is null for the first retained version.
 */
export const assetVersionDetailSchema = assetVersionSummarySchema.extend({
  externalId: z.string().nullable(),
  externalSource: z.string().nullable(),
  ...assetVersionStateSchema.shape,
  previous: assetVersionStateSchema.nullable(),
});
export type AssetVersionDetail = z.infer<typeof assetVersionDetailSchema>;

/**
 * Body of `POST .../versions/redact` (erasure; asset.purge permission +
 * step-up). `fieldId` alone blanks that field's value in ALL versions;
 * `version` alone blanks every captured value of that one version; both
 * blank that field in that version only. The row and its number stay,
 * marked redacted. At least one is required.
 */
export const redactAssetVersionsSchema = z
  .object({
    fieldId: z.guid().optional(),
    version: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict()
  .refine((v) => v.fieldId !== undefined || v.version !== undefined, {
    message: 'Provide fieldId, version, or both.',
  });
export type RedactAssetVersionsInput = z.infer<typeof redactAssetVersionsSchema>;
