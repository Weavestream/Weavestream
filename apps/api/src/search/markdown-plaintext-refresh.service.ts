import { markdownExcerpt, markdownToPlaintext } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Re-derive `contentPlaintext` and `derivedExcerpt` for Markdown
 * articles from their source, so a fix to `markdownToPlaintext`
 * reaches rows saved before it. Both columns are machine-derived;
 * the caller-suppliable `excerpt` is left alone.
 *
 * Safe beside live edits: each write matches the `markdown_source`
 * it was derived from, so an article edited after its batch was read
 * is skipped (the edit already wrote its own derived text). Raw SQL
 * also leaves `updated_at` alone — this is a derivation refresh, not
 * an edit — and the `articles` trigger still mirrors the new text
 * into `search_index`. Returns how many rows changed.
 *
 * Run on boot by `SearchRefreshService` when migration 0085 queued it.
 */
export async function refreshMarkdownPlaintext(
  prisma: PrismaService,
  batchSize = 200,
): Promise<number> {
  let changed = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.article.findMany({
      where: { editorMode: 'markdown', markdownSource: { not: null } },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, markdownSource: true, contentPlaintext: true, derivedExcerpt: true },
    });
    for (const row of batch) {
      const md = row.markdownSource ?? '';
      const contentPlaintext = markdownToPlaintext(md);
      const derivedExcerpt = markdownExcerpt(md) || null;
      if (contentPlaintext === row.contentPlaintext && derivedExcerpt === row.derivedExcerpt) continue;
      changed += await prisma.$executeRaw`
        UPDATE "articles"
        SET "content_plaintext" = ${contentPlaintext}, "derived_excerpt" = ${derivedExcerpt}
        WHERE "id" = ${row.id}::uuid
          AND "editor_mode" = 'markdown'
          AND "markdown_source" = ${md}`;
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1]!.id;
  }
  return changed;
}
