import { z } from 'zod';

/**
 * Folder slug: lowercase kebab-case, 1–60 chars. Uniqueness is enforced
 * per (company_id, parent_id) via a partial unique index on active rows.
 */
export const folderSlugSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

export const folderNameSchema = z.string().min(1).max(120);

export const createFolderSchema = z.object({
  name: folderNameSchema,
  slug: folderSlugSchema.optional(),
  parentId: z.string().uuid().nullable().optional(),
  icon: z.string().min(1).max(40).optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

export const updateFolderSchema = z
  .object({
    name: folderNameSchema.optional(),
    slug: folderSlugSchema.optional(),
    parentId: z.string().uuid().nullable().optional(),
    icon: z.string().min(1).max(40).nullable().optional(),
    position: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
