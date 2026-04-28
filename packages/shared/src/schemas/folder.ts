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

/**
 * Body for `DELETE /folders/:id` (soft-delete / archive). Tells the
 * server how to cascade to the articles currently in the folder:
 *   - `unassign` (default): set `folderId = NULL` so they fall back
 *     to "Unfiled".
 *   - `archive`: archive the articles too (set their `archivedAt`).
 * Required when the folder has at least one active article.
 */
export const archiveFolderSchema = z.object({
  articles: z.enum(['unassign', 'archive']).optional(),
});

export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
export type ArchiveFolderInput = z.infer<typeof archiveFolderSchema>;
