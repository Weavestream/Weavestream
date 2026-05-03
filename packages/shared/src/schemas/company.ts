import { z } from 'zod';

/**
 * Slug is used as the URL segment (e.g. `/admin/companies/:slug`) and as
 * a stable key inside integration payloads. Kept at 40 chars so the
 * sidebar and breadcrumbs don't need to truncate.
 */
export const companySlugSchema = z
  .string()
  .min(3, 'Slug must be at least 3 characters')
  .max(40, 'Slug must be at most 40 characters')
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

// Mirrors the Prisma enum. Source-of-truth lives in schema.prisma — this
// array must be kept in sync when values are added/removed.
export const companyTypeValues = [
  'CLIENT',
  'PROSPECT',
  'VENDOR',
  'INTERNAL',
  'PARTNER',
  'OTHER',
] as const;

export const companyTypeSchema = z.enum(companyTypeValues);
export type CompanyType = z.infer<typeof companyTypeSchema>;

// Mirrors the Prisma `StickyNoteSeverity` enum. Drives the sticky-note
// banner colour and (for CRITICAL) sticky positioning.
export const stickyNoteSeverityValues = ['INFO', 'WARN', 'CRITICAL'] as const;
export const stickyNoteSeveritySchema = z.enum(stickyNoteSeverityValues);
export type StickyNoteSeverity = z.infer<typeof stickyNoteSeveritySchema>;

// ───────────────────────────────────────────────────────────────────
// Field-level helpers
// ───────────────────────────────────────────────────────────────────

/**
 * Wrap an inner schema so empty strings round-trip as `null`. Forms
 * submit `""` when a user clears an optional field; the API should
 * store `NULL` so the downstream UI can branch on "set vs not set".
 */
function nullableTrimmedText<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    return v;
  }, inner.nullable());
}

const emailField = nullableTrimmedText(
  z.string().email('Invalid email').max(254),
);

/** Liberal phone validation — we only care that it's not obviously bogus. */
const phoneField = nullableTrimmedText(
  z
    .string()
    .min(3)
    .max(40)
    .regex(
      /^[+\-0-9 ().extEXT]+$/,
      'Phone must contain only digits, spaces, and phone punctuation',
    ),
);

const websiteField = nullableTrimmedText(
  z
    .string()
    .max(500)
    .refine(
      (v) => {
        if (!v) return true;
        // Accept bare hostnames too — the service normalises them to
        // https:// before storing. Reject only obviously unusable input.
        const candidate = /^https?:\/\//i.test(v) ? v : `https://${v}`;
        try {
          new URL(candidate);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Website must be a valid URL' },
    ),
);

const shortText = (max = 120) => nullableTrimmedText(z.string().max(max));
const longText = (max = 500) => nullableTrimmedText(z.string().max(max));

/** UUID or null — used for parent & logo foreign keys. */
const nullableUuid = z.preprocess(
  (v) => (v === '' ? null : v),
  z.string().uuid().nullable(),
);

// ───────────────────────────────────────────────────────────────────
// DTOs
// ───────────────────────────────────────────────────────────────────

// Create keeps the shape lean: name, slug, type, notes. Everything else
// is filled in on the dedicated Settings page right after creation.
export const createCompanySchema = z.object({
  name: z.string().min(1).max(120),
  slug: companySlugSchema,
  type: companyTypeSchema.default('CLIENT'),
  notes: z.string().max(4000).optional(),
});

// Assembled as a plain object so we can reuse the same set of field
// definitions for both the partial update DTO and downstream typings.
const companyMutableFields = {
  name: z.string().min(1).max(120),
  slug: companySlugSchema,
  type: companyTypeSchema,
  parentCompanyId: nullableUuid,
  logoUploadId: nullableUuid,

  notes: nullableTrimmedText(z.string().max(4000)),
  quickNotes: nullableTrimmedText(z.string().max(500)),

  contactName: shortText(120),
  contactTitle: shortText(120),
  contactEmail: emailField,
  contactPhone: phoneField,

  generalEmail: emailField,
  phone: phoneField,
  fax: phoneField,
  website: websiteField,

  addressLine1: shortText(200),
  addressLine2: shortText(200),
  city: shortText(120),
  region: shortText(120),
  postalCode: shortText(20),
  country: shortText(120),

  // Sticky note. Service layer reconciles the pair: when text is
  // null/empty, severity is forced to null too; when text is set
  // without a severity, severity defaults to INFO.
  stickyNoteText: nullableTrimmedText(z.string().max(300)),
  stickyNoteSeverity: stickyNoteSeveritySchema.nullable(),
} as const;

export const updateCompanySchema = z
  .object(
    Object.fromEntries(
      Object.entries(companyMutableFields).map(([k, v]) => [k, v.optional()]),
    ) as {
      [K in keyof typeof companyMutableFields]: z.ZodOptional<
        (typeof companyMutableFields)[K]
      >;
    },
  )
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
