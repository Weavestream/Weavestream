import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SearchIndexService } from './search-index.service.js';
import { SearchModule } from './search.module.js';
import { refreshMarkdownPlaintext } from './markdown-plaintext-refresh.service.js';

/** Which process this is: only the worker may finish a refresh. */
export type SearchRefreshRole = 'api' | 'worker';
const SEARCH_REFRESH_ROLE = Symbol('SEARCH_REFRESH_ROLE');

/** One search-text refresh a migration can queue by creating `marker`. */
interface SearchRefreshJob {
  /** Marker table name; also the probe and the `DROP TABLE` target. */
  marker: string;
  /** What the log calls the work, e.g. "Markdown article search text". */
  label: string;
  /** Does the work; returns how many rows it touched. */
  run: () => Promise<number>;
}

/**
 * Runs the search-text refreshes a migration queued, so an upgrade
 * fixes stored search text without an operator having to know about
 * `reindex-search`. Each job is queued by a marker table:
 *
 *   - `pending_markdown_plaintext_refresh` (migration 0085): re-derive
 *     Markdown article plaintext (`refreshMarkdownPlaintext`).
 *   - `pending_asset_search_reindex` (migration 0089): rebuild every
 *     asset's `search_index` row after more field types became
 *     searchable (`SearchIndexService.reindexAssets`).
 *
 * Every process that writes the derived text must be on the new code
 * before a refresh can be called done: an old process can still save a
 * row after it was scanned. During a Compose upgrade the previous
 * worker keeps running integration syncs (which write Markdown articles
 * and assets) until the new api is healthy, and Compose stops it before
 * starting its replacement. So:
 *
 *   - the api refreshes on boot (fixes almost every row early) but
 *     keeps the marker;
 *   - the worker refreshes again on boot — by then no old api or old
 *     worker is left — and only then drops the marker.
 *
 * Every normal boot pays one `to_regclass` probe per job and exits. The
 * work runs in the background (never delaying startup); a failure or a
 * shutdown mid-run keeps that job's marker, and the next boot resumes.
 * Each job is safe beside live edits: Markdown writes are guarded on
 * their source, and asset rebuilds take the per-asset row lock.
 *
 * The probe name is unqualified on purpose: the migration creates the
 * marker in the connection's search_path schema (see
 * IdentityRetargetDrainService for the same reasoning).
 */
@Injectable()
export class SearchRefreshService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SearchRefreshService.name);
  private stopped = false;
  private readonly jobs: SearchRefreshJob[];

  constructor(
    private readonly prisma: PrismaService,
    searchIndex: SearchIndexService,
    @Inject(SEARCH_REFRESH_ROLE) private readonly role: SearchRefreshRole,
  ) {
    this.jobs = [
      {
        marker: 'pending_markdown_plaintext_refresh',
        label: 'Markdown article search text',
        run: () => refreshMarkdownPlaintext(this.prisma),
      },
      {
        marker: 'pending_asset_search_reindex',
        label: 'Asset search text',
        run: () => searchIndex.reindexAssets(),
      },
    ];
  }

  onApplicationBootstrap(): void {
    void this.run();
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    for (const job of this.jobs) {
      if (this.stopped) return;
      await this.runJob(job);
    }
  }

  private async runJob(job: SearchRefreshJob): Promise<void> {
    try {
      const [row] = await this.prisma.$queryRaw<{ present: string | null }[]>`
        SELECT to_regclass(${job.marker})::text AS present`;
      if (row?.present == null) return;

      const changed = await job.run();
      if (this.role === 'worker') {
        // `job.marker` is one of the constant names above, never input;
        // a table name cannot be a bound parameter.
        await this.prisma.$executeRaw(
          Prisma.sql`DROP TABLE IF EXISTS ${Prisma.raw(`"${job.marker}"`)}`,
        );
        this.logger.log(`${job.label} refreshed (final pass): ${changed} row(s).`);
      } else {
        this.logger.log(
          `${job.label} refreshed: ${changed} row(s); the worker runs the final pass when it starts.`,
        );
      }
    } catch (error) {
      // A shutdown mid-run (the CLI closing, a redeploy) is not a failure.
      if (this.stopped) return;
      this.logger.error(
        `${job.label} refresh failed; it resumes on the next start: ${String(error)}`,
      );
    }
  }
}

/** Imported once per process with that process's role. Needs the global PrismaModule. */
@Module({})
export class SearchRefreshModule {
  static forProcess(role: SearchRefreshRole): DynamicModule {
    return {
      module: SearchRefreshModule,
      imports: [SearchModule],
      providers: [{ provide: SEARCH_REFRESH_ROLE, useValue: role }, SearchRefreshService],
    };
  }
}
