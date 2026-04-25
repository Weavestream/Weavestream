import { z } from 'zod';
import { MAX_MARKDOWN_SOURCE } from '../markdown.js';

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

export const articleEditorModeSchema = z.enum(['tiptap', 'markdown']);

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

const articleMetadataShape = {
  title: articleTitleSchema,
  slug: articleSlugSchema.optional(),
  folderId: z.string().uuid().nullable().optional(),
  excerpt: z.string().max(1000).optional(),
  visibleToClients: z.boolean().optional(),
} as const;

const markdownSourceSchema = z.string().min(1).max(MAX_MARKDOWN_SOURCE);

const createArticleTiptapSchema = z.object({
  ...articleMetadataShape,
  editorMode: z.literal('tiptap'),
  content: tiptapDocSchema,
});

const createArticleMarkdownSchema = z.object({
  ...articleMetadataShape,
  editorMode: z.literal('markdown'),
  markdownSource: markdownSourceSchema,
});

/**
 * `editorMode` discriminates the body. Legacy clients that omit
 * `editorMode` but send `content` are treated as `tiptap`.
 */
export const createArticleSchema = z.preprocess(
  (data) => {
    if (
      data &&
      typeof data === 'object' &&
      !('editorMode' in (data as object)) &&
      'content' in (data as object)
    ) {
      return { ...(data as Record<string, unknown>), editorMode: 'tiptap' };
    }
    return data;
  },
  z.discriminatedUnion('editorMode', [
    createArticleTiptapSchema,
    createArticleMarkdownSchema,
  ]),
);

export const updateArticleSchema = z
  .object({
    title: articleTitleSchema.optional(),
    slug: articleSlugSchema.optional(),
    folderId: z.string().uuid().nullable().optional(),
    editorMode: articleEditorModeSchema.optional(),
    content: tiptapDocSchema.optional(),
    markdownSource: markdownSourceSchema.optional(),
    excerpt: z.string().max(1000).nullable().optional(),
    visibleToClients: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided')
  .refine(
    (v) => !(v.content !== undefined && v.markdownSource !== undefined),
    { message: 'Cannot provide both content and markdownSource' },
  )
  .refine(
    (v) => {
      if (v.editorMode === 'tiptap' && v.markdownSource !== undefined) {
        return false;
      }
      if (v.editorMode === 'markdown' && v.content !== undefined) {
        return false;
      }
      return true;
    },
    { message: 'editorMode must match the body field (content vs markdownSource)' },
  );

export const moveArticleSchema = z.object({
  folderId: z.string().uuid().nullable(),
});

export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
export type MoveArticleInput = z.infer<typeof moveArticleSchema>;
export type ArticleEditorMode = z.infer<typeof articleEditorModeSchema>;
