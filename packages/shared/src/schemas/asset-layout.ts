import { z } from 'zod';

export const layoutSlugSchema = z
  .string()
  .min(2, 'Slug must be at least 2 characters')
  .max(60)
  .regex(
    /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
    'Slug must be lowercase snake_case',
  );

export const layoutNameSchema = z.string().min(1).max(80);

/**
 * Icon key shared with the design mock's layout swatch strip
 * (`laptop / server / router / box / license / globe` + a couple extras
 * we already ship). Web resolves the string to an icon component via the
 * existing `Icon` map in `apps/web/src/components/ui/icon.tsx`.
 */
export const layoutIconSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, 'Icon key must be lowercase snake_case');

/** CSS color or `var(--…)` token (so design tokens can be used directly). */
export const layoutColorSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(
    /^(#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]+\)|[a-z]+)$/,
    'Color must be a hex, var(--…), or named CSS color',
  );

export const createAssetLayoutSchema = z.object({
  name: layoutNameSchema,
  slug: layoutSlugSchema,
  icon: layoutIconSchema,
  color: layoutColorSchema,
  /**
   * Optional at create — service appends the new layout at the end of
   * the global ordering when omitted. Operators drive curated ordering
   * through the reorder endpoint instead.
   */
  position: z.number().int().min(0).optional(),
});

export const updateAssetLayoutSchema = z
  .object({
    name: layoutNameSchema.optional(),
    slug: layoutSlugSchema.optional(),
    icon: layoutIconSchema.optional(),
    color: layoutColorSchema.optional(),
    isActive: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

/**
 * Payload for `PATCH /layouts/reorder`. The client sends the
 * authoritative ordered list of *active* layout ids; the service
 * assigns positions 0..N-1 in a single transaction so the sidebar
 * order stays deterministic and cheap to query
 * (`ORDER BY position ASC, name ASC`).
 */
export const reorderAssetLayoutsSchema = z.object({
  orderedIds: z
    .array(z.string().uuid())
    .min(1, 'orderedIds must contain at least one id')
    .max(500, 'orderedIds has an implausible length')
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'orderedIds must be unique',
    ),
});

export type CreateAssetLayoutInput = z.infer<typeof createAssetLayoutSchema>;
export type UpdateAssetLayoutInput = z.infer<typeof updateAssetLayoutSchema>;
export type ReorderAssetLayoutsInput = z.infer<typeof reorderAssetLayoutsSchema>;
