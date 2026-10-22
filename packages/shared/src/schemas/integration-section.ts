import { z } from 'zod';
import { isValidHttpUrl } from './http-url.js';

/**
 * Integration sections: driver-supplied, read-only detail cards rendered
 * on the asset page (one collapsible panel per integration binding).
 *
 * Data from an external system never adds fields to the operator's
 * layouts; it lives here instead. Everything is plain data: strings are
 * length-capped and may not contain markup or control characters, links
 * are http(s) only, and the whole section is size-capped. The web app
 * renders values as text, never as HTML.
 */

/** Icons a section or group may name; each maps to `/integrations/icons/<slug>.svg`. */
export const INTEGRATION_SECTION_ICONS = [
  'google',
  'gmail',
  'google-drive',
  'google-admin',
  'chrome',
  'android',
  'level',
  'microsoft',
  'ninjaone',
  'action1',
] as const;
export const integrationSectionIconSchema = z.enum(INTEGRATION_SECTION_ICONS);
export type IntegrationSectionIcon = z.infer<typeof integrationSectionIconSchema>;

export const INTEGRATION_SECTION_LIMITS = {
  groups: 12,
  rowsPerGroup: 40,
  listItems: 50,
  titleLength: 120,
  labelLength: 120,
  textLength: 1_000,
  listItemLength: 200,
  /** Serialized JSON size cap for one section. */
  bytes: 64 * 1024,
} as const;

// eslint-disable-next-line no-control-regex -- matching controls is the point
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Tag-, comment- or doctype-shaped text (`<b>`, `</x>`, `<!--`, `<?`). */
const MARKUP_RE = /<[a-z!/?]/i;

function plainText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => !CONTROL_CHARS_RE.test(value), 'Control characters are not allowed')
    .refine((value) => !MARKUP_RE.test(value), 'Markup is not allowed');
}

const finiteNumber = z.number().finite();
const isoDateString = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Must be an ISO date');

const label = plainText(INTEGRATION_SECTION_LIMITS.labelLength).pipe(z.string().min(1));

const rowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), label, value: plainText(INTEGRATION_SECTION_LIMITS.textLength) }).strict(),
  z.object({ kind: z.literal('number'), label, value: finiteNumber }).strict(),
  z.object({ kind: z.literal('bytes'), label, value: finiteNumber.nonnegative() }).strict(),
  z.object({ kind: z.literal('date'), label, value: isoDateString }).strict(),
  z.object({ kind: z.literal('datetime'), label, value: isoDateString }).strict(),
  z.object({ kind: z.literal('boolean'), label, value: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('badge'),
      label,
      value: plainText(64).pipe(z.string().min(1)),
      tone: z.enum(['neutral', 'success', 'warning', 'danger']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('link'),
      label,
      value: z.string().max(2048).refine(isValidHttpUrl, 'Links must be http(s) URLs'),
      text: plainText(INTEGRATION_SECTION_LIMITS.labelLength).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('list'),
      label,
      value: z
        .array(plainText(INTEGRATION_SECTION_LIMITS.listItemLength))
        .max(INTEGRATION_SECTION_LIMITS.listItems),
    })
    .strict(),
  z
    .object({
      kind: z.literal('meter'),
      label,
      used: finiteNumber.nonnegative(),
      total: finiteNumber.positive(),
      unit: z.enum(['bytes', 'mb', 'count']),
      value: plainText(INTEGRATION_SECTION_LIMITS.labelLength).optional(),
      /** Coverage-style meter (e.g. 2SV): a low fill is the warning, not a high one. */
      higherIsBetter: z.boolean().optional(),
    })
    .strict(),
]);
export type IntegrationSectionRow = z.infer<typeof rowSchema>;
export type IntegrationSectionRowKind = IntegrationSectionRow['kind'];

const groupSchema = z
  .object({
    key: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
    title: plainText(INTEGRATION_SECTION_LIMITS.titleLength).pipe(z.string().min(1)),
    icon: integrationSectionIconSchema.optional(),
    rows: z.array(rowSchema).max(INTEGRATION_SECTION_LIMITS.rowsPerGroup),
  })
  .strict();
export type IntegrationSectionGroup = z.infer<typeof groupSchema>;

export const integrationSectionSchema = z
  .object({
    title: plainText(INTEGRATION_SECTION_LIMITS.titleLength).pipe(z.string().min(1)),
    /** Absent: the panel shows the driver's own logo. */
    icon: integrationSectionIconSchema.optional(),
    groups: z.array(groupSchema).min(1).max(INTEGRATION_SECTION_LIMITS.groups),
  })
  .strict()
  .superRefine((section, ctx) => {
    const keys = section.groups.map((group) => group.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groups'], message: 'Group keys must be unique' });
    }
    if (new TextEncoder().encode(JSON.stringify(section)).byteLength > INTEGRATION_SECTION_LIMITS.bytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Section is too large' });
    }
  });
export type IntegrationSection = z.infer<typeof integrationSectionSchema>;

/** One section as returned on an asset: which binding it came from, plus the data. */
export const assetIntegrationSectionSchema = z.object({
  integrationId: z.guid(),
  driver: z.string(),
  integrationName: z.string(),
  lastSyncedAt: z.string(),
  /** False once the binding is no longer active (the record left the source): history stays visible, tagged. */
  active: z.boolean().optional(),
  section: integrationSectionSchema,
  /** The record's own page in the source system (built by the API from driver code, never stored). */
  sourceUrl: z.string().max(2048).refine(isValidHttpUrl, 'Links must be http(s) URLs').optional(),
  /** The binding row, for resolving differences. */
  syncRecordId: z.guid().optional(),
  /** Standard fields a person changed that now differ from the source (named after `section.title`). */
  differences: z
    .array(
      z.object({
        syncRecordId: z.guid(),
        assetFieldId: z.guid(),
        fieldLabel: z.string(),
        localValue: z.string().nullable(),
        sourceValue: z.string().nullable(),
        detectedAt: z.string(),
      }),
    )
    .optional(),
});
export type AssetIntegrationSection = z.infer<typeof assetIntegrationSectionSchema>;
