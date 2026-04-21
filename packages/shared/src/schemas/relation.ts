import { z } from 'zod';

/**
 * Phase 5 polymorphic relation schemas. The `Relation` table stores the
 * endpoint types as free-text strings (`Asset`, `Article`, …), but the
 * Phase 5 API only accepts Asset + Article endpoints. New kinds graduate
 * by being added to `relationEndpointKinds` once the UI catches up.
 */
export const relationEndpointKinds = ['asset', 'article'] as const;
export type RelationEndpointKind = (typeof relationEndpointKinds)[number];

export const relationEndpointKindSchema = z.enum(relationEndpointKinds);

/**
 * Free-text `relationType` label ("primary_user", "depends_on", "host").
 * Kept short to fit as a pill and bounded so the unique composite key
 * index stays efficient.
 */
export const relationTypeSchema = z
  .string()
  .trim()
  .min(1, 'relationType must not be empty')
  .max(80, 'relationType must be 80 characters or fewer');

export const createRelationSchema = z
  .object({
    sourceType: relationEndpointKindSchema,
    sourceId: z.string().uuid(),
    targetType: relationEndpointKindSchema,
    targetId: z.string().uuid(),
    relationType: relationTypeSchema.optional(),
  })
  .refine(
    (v) => !(v.sourceType === v.targetType && v.sourceId === v.targetId),
    { message: 'A relation cannot point at itself.', path: ['targetId'] },
  );

export type CreateRelationInput = z.infer<typeof createRelationSchema>;
