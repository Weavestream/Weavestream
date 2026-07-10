import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { tiptapDocToMarkdown } from '@weavestream/shared';
import type { GetArticleToolInput, GetArticleToolOutput } from '@weavestream/shared';
import { ArticlesService } from '../../articles/articles.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { entityHrefFor } from '../../search/entity-href.js';
import { AI_TOOL_SPECS } from '../tool-specs.js';
import { EntityScopeService } from '../entity-scope.js';
import type { AiReadTool, AiToolExecutionContext } from '../tool-registry.js';

/** One chunk of body per read; long articles continue via cursor. */
const CHUNK_CHARS = 20_000;

/**
 * Continuation cursor payload. The encoded token is UNTRUSTED INPUT:
 * it is decoded only after `article_id` has been fully authorized,
 * schema-validated, and every field is re-verified against the freshly
 * authorized row (id match, bounded offset, revision match). No
 * signature needed — a forged cursor can only yield an offset into a
 * document the actor already fully authorized on THIS call.
 */
const cursorPayloadSchema = z.object({
  articleId: z.string().uuid(),
  offset: z.number().int().min(0),
  revision: z.number().int().positive(),
});

@Injectable()
export class GetArticleAiTool implements AiReadTool {
  readonly spec = AI_TOOL_SPECS.get_article;

  constructor(
    private readonly articles: ArticlesService,
    private readonly entityScope: EntityScopeService,
    private readonly prisma: PrismaService,
  ) {}

  async resolveCompanyId(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const input = args as GetArticleToolInput;
    return this.entityScope.resolveEntityCompany(ctx.tenant, 'article', input.article_id);
  }

  async execute(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
    companyId: string | null,
  ): Promise<GetArticleToolOutput> {
    const input = args as GetArticleToolInput;
    if (companyId === null) throw new NotFoundException();

    // Enforces CLIENT_USER visibility at the query layer (404 for
    // hidden rows) — defense in depth under the executor's
    // article.read entry gate.
    const article = await this.articles.getById(ctx.actor, companyId, input.article_id);

    // Structure-preserving body: markdown articles verbatim, Tiptap
    // articles through the shared JSON walker; plaintext only as the
    // last-resort fallback for docs the walker can't render.
    const body =
      article.editorMode === 'markdown'
        ? (article.markdownSource ?? '')
        : tiptapDocToMarkdown(article.content) || article.contentPlaintext;

    // Cursor validation — strictly AFTER authorization, above.
    let offset = 0;
    if (input.cursor !== undefined) {
      const payload = decodeCursor(input.cursor);
      if (
        payload === null ||
        payload.articleId !== input.article_id ||
        payload.revision !== article.revision ||
        payload.offset > body.length
      ) {
        // Tampered, or the article changed mid-read: the model
        // re-reads from the start. Generic toward the model.
        throw new NotFoundException();
      }
      offset = payload.offset;
    }

    const markdown = body.slice(offset, offset + CHUNK_CHARS);
    const truncated = offset + CHUNK_CHARS < body.length;
    const nextCursor = truncated
      ? encodeCursor({
          articleId: article.id,
          offset: offset + CHUNK_CHARS,
          revision: article.revision,
        })
      : null;

    const company = await this.prisma.company.findFirst({
      where: { id: companyId },
      select: { slug: true },
    });

    return {
      id: article.id,
      title: article.title,
      markdown,
      revision: article.revision,
      href: entityHrefFor({
        kind: 'article',
        entityId: article.id,
        companyId,
        companySlug: company?.slug ?? '',
        articleSlug: article.slug,
        isClient: ctx.actor.role === 'CLIENT_USER',
      }),
      visibleToClients: article.visibleToClients,
      updatedAt: article.updatedAt.toISOString(),
      truncated,
      nextCursor,
    };
  }
}

function encodeCursor(payload: z.infer<typeof cursorPayloadSchema>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): z.infer<typeof cursorPayloadSchema> | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    const result = cursorPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
