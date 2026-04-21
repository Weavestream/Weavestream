import { z } from 'zod';
import {
  FieldTypeValues,
  fieldOptionChoiceSchema,
  type FieldType,
} from './field-types.js';

/**
 * Lowercase snake_case field slug — stable identifier the backend uses to
 * key `AssetFieldValue` lookups and the frontend uses in `field.<slug>=`
 * filter DSL. Slugs are unique per layout (partial unique index skips
 * archived rows).
 */
export const fieldSlugSchema = z
  .string()
  .min(1, 'Slug is required')
  .max(60, 'Slug must be at most 60 characters')
  .regex(
    /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
    'Slug must be lowercase snake_case (start with a letter)',
  );

export const fieldLabelSchema = z.string().min(1).max(80);

/**
 * Option shapes per FieldType. The `AssetField.options` JSONB is validated
 * at layout save time against the *type-specific* schema — callers use
 * `fieldOptionsSchemaFor(type)` rather than a single union so Zod issues
 * point at the right subfield.
 */
export const dropdownOptionsSchema = z
  .object({
    choices: z.array(fieldOptionChoiceSchema).min(1).max(500),
    allowOther: z.boolean().default(false),
  })
  .strict();

export const multiselectOptionsSchema = z
  .object({
    choices: z.array(fieldOptionChoiceSchema).min(1).max(500),
    maxSelections: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const dateOptionsSchema = z
  .object({
    /**
     * Marks this field as an "expiry date". Drives the warranty countdown
     * chip in the AssetDetail header and the colour-coded warranty cell
     * in AssetList. At most one expiry field per layout is a soft
     * convention, not enforced — the UI uses the earliest upcoming one.
     */
    isExpiry: z.boolean().default(false),
    warnWithinDays: z.number().int().positive().max(3650).optional(),
  })
  .strict();

export const datetimeOptionsSchema = dateOptionsSchema;

export const assetReferenceOptionsSchema = z
  .object({
    /** UUID of the target AssetLayout — writes upsert Relation rows. */
    targetLayoutId: z.string().uuid(),
    /**
     * Relation verb persisted on `Relation.relationType` (e.g.
     * `primary_user`). Defaults to the field's own slug.
     */
    relationType: z.string().min(1).max(80).optional(),
    /** Whether the target is a single asset or an array. */
    multiple: z.boolean().default(false),
  })
  .strict();

export const fileOptionsSchema = z
  .object({
    accept: z.array(z.string().max(40)).max(20).optional(),
    maxSizeMb: z.number().int().positive().max(1024).default(25),
    multiple: z.boolean().default(false),
  })
  .strict();

/**
 * Shape of an `IP_ADDRESS` field's options. Stored on `AssetField.options`
 * and consumed by the API strategy to pick the right regex + by the web
 * form/detail view to drive affordances (placeholder, monospace, chips).
 *
 * The IPAM feature shipping in a later phase will additionally read these
 * options to decide whether a field participates in subnet grouping
 * (`allowCidr`) or conflict detection (`version`).
 */
export const ipAddressOptionsSchema = z
  .object({
    /** Restrict input to a specific IP family. `any` accepts either. */
    version: z.enum(['v4', 'v6', 'any']).default('any'),
    /**
     * When true, the value may include a `/N` CIDR suffix, which lets
     * the same field store either a host address (`10.0.0.5`) or a
     * subnet (`10.0.0.0/24`).
     */
    allowCidr: z.boolean().default(false),
  })
  .strict();

const emptyOptions = z.object({}).strict();

/**
 * Pick the right options schema for a field type. Used on the API (layout
 * save) and on the web (inspector form) so the two halves never drift.
 */
export function fieldOptionsSchemaFor(type: FieldType): z.ZodTypeAny {
  switch (type) {
    case 'DROPDOWN':
      return dropdownOptionsSchema;
    case 'MULTISELECT':
      return multiselectOptionsSchema;
    case 'DATE':
      return dateOptionsSchema;
    case 'DATETIME':
      return datetimeOptionsSchema;
    case 'ASSET_REFERENCE':
      return assetReferenceOptionsSchema;
    case 'FILE':
      return fileOptionsSchema;
    case 'IP_ADDRESS':
      return ipAddressOptionsSchema;
    default:
      return emptyOptions;
  }
}

/**
 * Shape used on create. `position` is optional at the API layer — the
 * service appends the field at the end if not provided, matching the
 * builder's "drop a field at the bottom" default.
 */
/**
 * Field types whose rendered cell would be unreadable in the per-layout
 * table view and are therefore disallowed from `showInTable = true`.
 * Rich text would blow cell heights; file lists need thumbnail chips
 * and don't summarise; we surface both through the asset detail page
 * instead.
 */
export const NON_TABULAR_FIELD_TYPES = ['RICH_TEXT', 'FILE'] as const satisfies ReadonlyArray<
  FieldType
>;

export function canShowInTable(fieldType: FieldType): boolean {
  return !NON_TABULAR_FIELD_TYPES.includes(
    fieldType as (typeof NON_TABULAR_FIELD_TYPES)[number],
  );
}

export const createAssetFieldSchema = z.object({
  name: fieldLabelSchema,
  slug: fieldSlugSchema,
  fieldType: z.enum(FieldTypeValues),
  position: z.number().int().min(0).optional(),
  isRequired: z.boolean().default(false),
  isUniquePerCompany: z.boolean().default(false),
  visibleToClients: z.boolean().default(true),
  isPrimary: z.boolean().default(false),
  showInTable: z.boolean().default(false),
  options: z.record(z.unknown()).default({}),
});

export type CreateAssetFieldInput = z.infer<typeof createAssetFieldSchema>;

/**
 * Shape used on update. `fieldType` is deliberately *omitted* —
 * changing a field's type would invalidate every stored value whose JSON
 * shape was validated against the previous strategy. See DECISIONS.md
 * D-009 field-type-immutable. The builder inspector reflects this by
 * showing `Type` as read-only on existing fields.
 */
export const updateAssetFieldSchema = z
  .object({
    name: fieldLabelSchema.optional(),
    slug: fieldSlugSchema.optional(),
    position: z.number().int().min(0).optional(),
    isRequired: z.boolean().optional(),
    isUniquePerCompany: z.boolean().optional(),
    visibleToClients: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
    showInTable: z.boolean().optional(),
    options: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type UpdateAssetFieldInput = z.infer<typeof updateAssetFieldSchema>;

/**
 * Payload for the atomic field-list save. The API accepts a diff:
 * - rows with `id` are updated (or left alone if no diff)
 * - rows without `id` are created
 * - ids missing from the payload are archived
 * `PUT /layouts/:id/fields?force=true` is required if the diff would
 * remove a field that already has values in any company.
 */
export const saveAssetFieldsSchema = z.object({
  fields: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: fieldLabelSchema,
        slug: fieldSlugSchema,
        fieldType: z.enum(FieldTypeValues),
        position: z.number().int().min(0),
        isRequired: z.boolean().default(false),
        isUniquePerCompany: z.boolean().default(false),
        visibleToClients: z.boolean().default(true),
        isPrimary: z.boolean().default(false),
        showInTable: z.boolean().default(false),
        options: z.record(z.unknown()).default({}),
      }),
    )
    .min(1, 'A layout needs at least one field')
    .max(100, 'A layout can have at most 100 fields')
    .refine(
      (fields) => fields.filter((f) => f.isPrimary).length === 1,
      'Exactly one field must be marked primary',
    )
    .refine(
      (fields) =>
        new Set(fields.map((f) => f.slug)).size === fields.length,
      'Field slugs must be unique within the layout',
    )
    .refine(
      (fields) =>
        fields.every(
          (f) => !f.showInTable || canShowInTable(f.fieldType),
        ),
      {
        message:
          'showInTable is not supported for RICH_TEXT or FILE fields (their cells would be unreadable in a table).',
      },
    ),
});

export type SaveAssetFieldsInput = z.infer<typeof saveAssetFieldsSchema>;
