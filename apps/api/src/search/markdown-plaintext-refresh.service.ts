import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
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

/** Which process this is: only the worker may finish the refresh. */
export type MarkdownRefreshRole = 'api' | 'worker';
const MARKDOWN_REFRESH_ROLE = Symbol('MARKDOWN_REFRESH_ROLE');

/**
 * Runs the Markdown plaintext refresh a migration queued (see
 * migration 0085), so an upgrade fixes stored search text without an
 * operator having to know about `reindex-search`.
 *
 * Every process that writes articles with the extractor must be on the
 * new code before the refresh can be called done: an old process can
 * still save an article after its row was scanned. During a Compose
 * upgrade the previous worker keeps running integration syncs (which
 * write Markdown articles) until the new api is healthy, and Compose
 * stops it before starting its replacement. So:
 *
 *   - the api refreshes on boot (fixes almost every row early) but
 *     keeps the marker;
 *   - the worker refreshes again on boot — by then no old api or old
 *     worker is left — and only then drops the marker.
 *
 * Every normal boot pays one `to_regclass` probe and exits. The work
 * runs in the background (never delaying startup); a failure or a
 * shutdown mid-run keeps the marker, and the next boot resumes. Row
 * writes are guarded on their source, so concurrent runs and live
 * edits are safe.
 *
 * The probe name is unqualified on purpose: the migration creates the
 * marker in the connection's search_path schema (see
 * IdentityRetargetDrainService for the same reasoning).
 */
@Injectable()
export class MarkdownPlaintextRefreshService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MarkdownPlaintextRefreshService.name);
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKDOWN_REFRESH_ROLE) private readonly role: MarkdownRefreshRole,
  ) {}

  onApplicationBootstrap(): void {
    void this.run();
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    try {
      const [row] = await this.prisma.$queryRaw<{ present: string | null }[]>`
        SELECT to_regclass('pending_markdown_plaintext_refresh')::text AS present`;
      if (row?.present == null) return;

      const changed = await refreshMarkdownPlaintext(this.prisma);
      if (this.role === 'worker') {
        await this.prisma.$executeRaw`DROP TABLE IF EXISTS "pending_markdown_plaintext_refresh"`;
        this.logger.log(`Markdown article search text refreshed (final pass): ${changed} article(s) updated.`);
      } else {
        this.logger.log(
          `Markdown article search text refreshed: ${changed} article(s) updated; the worker runs the final pass when it starts.`,
        );
      }
    } catch (error) {
      // A shutdown mid-run (the CLI closing, a redeploy) is not a failure.
      if (this.stopped) return;
      this.logger.error(
        `Markdown article search text refresh failed; it resumes on the next start: ${String(error)}`,
      );
    }
  }
}

/** Imported once per process with that process's role. Needs the global PrismaModule. */
@Module({})
export class MarkdownPlaintextRefreshModule {
  static forProcess(role: MarkdownRefreshRole): DynamicModule {
    return {
      module: MarkdownPlaintextRefreshModule,
      providers: [{ provide: MARKDOWN_REFRESH_ROLE, useValue: role }, MarkdownPlaintextRefreshService],
    };
  }
}
