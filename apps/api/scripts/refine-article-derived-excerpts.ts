#!/usr/bin/env ts-node
/**
 * Mobile Phase 4 — refine `articles.derived_excerpt` (run once after
 * deploying the 0067 migration; safe to re-run any time).
 *
 *   pnpm --filter @weavestream/api exec ts-node scripts/refine-article-derived-excerpts.ts --dry-run
 *   pnpm --filter @weavestream/api exec ts-node scripts/refine-article-derived-excerpts.ts
 *
 * Migration 0067 seeded `derived_excerpt` in SQL from
 * `content_plaintext` so the projected article list never served a
 * blank excerpt — but the SQL seed cannot be image-aware, so a legacy
 * row whose body LEADS with an image shows its alt-text-ish plaintext
 * head until this pass replaces the seed with the app's real
 * derivation (`markdownExcerpt`/`tiptapExcerpt`, the exact helpers the
 * write path uses).
 *
 * Safety properties, all load-bearing:
 *  - `derived_excerpt` is EXCLUSIVELY machine-written (the legacy
 *    `excerpt` column, which may hold caller-authored values of
 *    unknowable provenance, is never read or written here) — so
 *    recomputing every row is safe by construction.
 *  - Idempotent: recompute-and-write-only-when-different.
 *  - Concurrent-edit safe: each UPDATE pins `revision` in its WHERE, so
 *    a row edited between our read and write (whose write path already
 *    stored a fresher derivation) is skipped, never stomped.
 *  - Keyset-paginated batches; never loads the whole corpus.
 */
import { PrismaClient } from '@weavestream/db';
import { markdownExcerpt, tiptapExcerpt } from '@weavestream/shared';

const BATCH = 200;
const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let cursor: string | null = null;
  let scanned = 0;
  let wouldChange = 0;
  let changed = 0;
  let skippedStale = 0;

  try {
    for (;;) {
      const rows: Array<{
        id: string;
        companyId: string;
        revision: number;
        editorMode: string;
        markdownSource: string | null;
        content: unknown;
        derivedExcerpt: string | null;
      }> = await prisma.article.findMany({
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          companyId: true,
          revision: true,
          editorMode: true,
          markdownSource: true,
          content: true,
          derivedExcerpt: true,
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      scanned += rows.length;

      for (const row of rows) {
        const derived =
          row.editorMode === 'markdown'
            ? typeof row.markdownSource === 'string'
              ? markdownExcerpt(row.markdownSource)
              : ''
            : row.content != null
              ? tiptapExcerpt(row.content)
              : '';
        const next = derived || null;
        if (next === row.derivedExcerpt) continue;
        wouldChange += 1;
        if (DRY_RUN) continue;
        const res = await prisma.article.updateMany({
          where: { id: row.id, companyId: row.companyId, revision: row.revision },
          data: { derivedExcerpt: next },
        });
        if (res.count === 0) skippedStale += 1;
        else changed += 1;
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  if (DRY_RUN) {
    console.log(
      `[refine-derived-excerpts] DRY RUN: ${scanned} scanned, ` +
        `${wouldChange} would change`,
    );
  } else {
    console.log(
      `[refine-derived-excerpts] ${scanned} scanned, ${changed} refined` +
        (skippedStale ? `, ${skippedStale} skipped (edited concurrently)` : ''),
    );
  }
}

main().catch((err) => {
  console.error('[refine-derived-excerpts] failed:', err);
  process.exit(1);
});
