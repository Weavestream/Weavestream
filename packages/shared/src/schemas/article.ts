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
    // When `true`, the API coalesces this write into the article's
    // single rolling draft `ArticleVersion` row instead of producing
    // a new published version. Sent by the web editor's autosave
    // timer; explicit Save omits the flag. The server does NOT verify
    // the workspace autosave setting before honouring this flag —
    // worst case is the same draft row a legitimate autosave would
    // create.
    draft: z.boolean().optional(),
  })
  .refine(
    (v) => Object.keys(v).filter((k) => k !== 'draft').length > 0,
    'At least one field must be provided',
  )
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

/**
 * Metadata-only shape returned from `GET /articles/:id/versions`. The
 * body is omitted so the history list stays cheap; callers fetch
 * `GET /articles/:id/versions/:version` for the full snapshot when a
 * user opens the preview drawer or restores.
 */
export const articleVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  isDraft: z.boolean(),
  title: z.string(),
  slug: z.string(),
  editorMode: articleEditorModeSchema,
  changedFields: z.array(z.string()),
  changedBy: z.string().uuid(),
  changedByName: z.string().nullable(),
  changeReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const articleVersionDetailSchema = articleVersionSummarySchema.extend({
  folderId: z.string().uuid().nullable(),
  visibleToClients: z.boolean(),
  content: z.unknown().nullable(),
  markdownSource: z.string().nullable(),
  contentPlaintext: z.string(),
  excerpt: z.string().nullable(),
});

export type ArticleVersionSummary = z.infer<typeof articleVersionSummarySchema>;
export type ArticleVersionDetail = z.infer<typeof articleVersionDetailSchema>;

/** `{ id, name }` stub the API hydrates for createdBy/updatedBy. */
export const articleActorRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

/**
 * Wire shape of `GET /companies/:id/articles` list ITEMS — metadata
 * only (Phase 4). List and detail used to share one shape, which meant
 * every list row carried the full body + plaintext: 50 rows × up to
 * 500k chars of Markdown approached tens of MB per page, and the
 * mobile infinite query retains every loaded page. The server now
 * projects list rows to this shape at the QUERY layer (the body
 * columns never leave Postgres for a list).
 *
 * `excerpt` carries the serve-time coalesce `aiSummary ?? derivedExcerpt`
 * — same wire name as before; clients don't care which source filled
 * it. List rows hard-code `hasDraft: false` and `isStarred: false`
 * (unchanged — cheap listing).
 */
export const articleSummarySchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  visibleToClients: z.boolean(),
  revision: z.number().int(),
  archivedAt: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  updatedBy: z.string().uuid().nullable(),
  createdByUser: articleActorRefSchema.nullable(),
  updatedByUser: articleActorRefSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isStarred: z.boolean(),
  hasDraft: z.boolean(),
});

/**
 * `GET /companies/:id/articles/:id` — the summary plus the body (the
 * `articleVersionSummarySchema`/`articleVersionDetailSchema` pattern
 * above, applied to the article itself).
 *
 * `content` stays `unknown`: it is Tiptap/ProseMirror JSON that readers
 * must feed through `normaliseTiptapDoc` anyway (legacy `{ v, plain }`
 * rows exist), so deep-typing it here would only invite direct access.
 *
 * `provenance` is deliberately omitted: the wire superset is fine under
 * structural typing, no mobile/web reader consumes it from this type,
 * and typing it would drag the integration-provenance vocabulary into
 * every client that imports the article shape.
 */
export const articleDetailSchema = articleSummarySchema.extend({
  editorMode: articleEditorModeSchema,
  content: z.unknown().nullable(),
  markdownSource: z.string().nullable(),
  contentPlaintext: z.string(),
});

export type ArticleActorRef = z.infer<typeof articleActorRefSchema>;
export type ArticleSummary = z.infer<typeof articleSummarySchema>;
export type ArticleDetail = z.infer<typeof articleDetailSchema>;
