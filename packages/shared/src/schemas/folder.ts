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

/**
 * Wire shape of `GET /companies/:id/folders` (and `/folders/tree`) items:
 * the article-folder tree, nested via `children`. `articleCount` counts
 * non-archived articles directly in the folder (client users see
 * visible-only counts — the server filters before serializing).
 *
 * Recursive, so the interface is declared first and the schema refers to
 * itself through `z.lazy` (same pattern as `tiptapNodeSchema`).
 */
export interface FolderNode {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  slug: string;
  icon: string | null;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  articleCount: number;
  children: FolderNode[];
}

export const folderNodeSchema: z.ZodType<FolderNode> = z.lazy(() =>
  z.object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    name: z.string(),
    slug: z.string(),
    icon: z.string().nullable(),
    position: z.number().int(),
    archivedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    articleCount: z.number().int(),
    children: z.array(folderNodeSchema),
  }),
);
