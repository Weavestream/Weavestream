import { z } from 'zod';

/**
 * Article slug: lowercase kebab-case, 1–80 chars. Uniqueness is enforced
 * per company via a partial unique index on active (non-archived) rows.
 */
export const articleSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

export const articleTitleSchema = z.string().min(1).max(200);

/**
 * A Tiptap / ProseMirror JSON document. We keep the Zod shape loose
 * (root `doc` + array of nodes) and delegate the deep structural check
 * to `isValidTiptapDoc` in `@weavestream/shared/tiptap`. The API calls
 * `tiptapToPlaintext` on ingest, which tolerates unknown node types, so
 * the editor is free to add extensions without breaking the round-trip.
 */
export const tiptapNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    attrs: z.record(z.unknown()).optional(),
    content: z.array(tiptapNodeSchema).optional(),
    text: z.string().optional(),
    marks: z
      .array(
        z.object({
          type: z.string().min(1),
          attrs: z.record(z.unknown()).optional(),
        }),
      )
      .optional(),
  }),
);

export const tiptapDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(tiptapNodeSchema).optional(),
});

export const createArticleSchema = z.object({
  title: articleTitleSchema,
  slug: articleSlugSchema.optional(),
  folderId: z.string().uuid().nullable().optional(),
  content: tiptapDocSchema,
  excerpt: z.string().max(1000).optional(),
  visibleToClients: z.boolean().optional(),
});

export const updateArticleSchema = z
  .object({
    title: articleTitleSchema.optional(),
    slug: articleSlugSchema.optional(),
    folderId: z.string().uuid().nullable().optional(),
    content: tiptapDocSchema.optional(),
    excerpt: z.string().max(1000).nullable().optional(),
    visibleToClients: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export const moveArticleSchema = z.object({
  folderId: z.string().uuid().nullable(),
});

export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
export type MoveArticleInput = z.infer<typeof moveArticleSchema>;
