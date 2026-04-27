import { z } from 'zod';

/**
 * Tags are global first-class entities — no companyId, no layout scope.
 * Any authenticated user can create a tag inline while editing an asset
 * (the asset-write transaction upserts unknown names → ids); rename and
 * delete are gated by `tag.manage.global` (TAG_MANAGE / SUPER_ADMIN).
 *
 * Names are stored case-preserved for display and uniqueness is enforced
 * case-insensitively via an app-maintained `nameLower` column.
 */

export const TAG_NAME_MIN = 1;
export const TAG_NAME_MAX = 60;

export const tagNameSchema = z
  .string()
  .trim()
  .min(TAG_NAME_MIN, 'Tag name is required')
  .max(TAG_NAME_MAX, `Tag name must be ${TAG_NAME_MAX} characters or fewer`);

export const createTagSchema = z.object({
  name: tagNameSchema,
});

export const updateTagSchema = z.object({
  name: tagNameSchema,
});

export const listTagsQuerySchema = z.object({
  q: z.string().trim().max(TAG_NAME_MAX).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const tagSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Wire shape used inside an asset write payload for a TAGS field. Web sends
 * a mixed array: known tags as their UUID, newly typed tags as `{ name }`.
 * The asset-write transaction resolves `{ name }` entries via a server-side
 * upsert before persisting, so what ends up in `AssetFieldValue.value` is
 * always a plain `string[]` of UUIDs.
 */
export const tagsFieldInputSchema = z
  .array(
    z.union([
      z.string().uuid(),
      z.object({ name: tagNameSchema }).strict(),
    ]),
  )
  .max(100);

export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type ListTagsQuery = z.infer<typeof listTagsQuerySchema>;
export type Tag = z.infer<typeof tagSchema>;
export type TagsFieldInput = z.infer<typeof tagsFieldInputSchema>;
