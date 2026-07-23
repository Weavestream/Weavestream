import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Drains the durable helper table migration 0062 leaves behind when
 * sync records could not be retargeted to their canonical assets
 * during deploy.
 *
 * The migration dedupes duplicate external identities and moves the
 * losers' `integration_sync_records` bindings to the canonical row,
 * but it must never wait on a record row a concurrent sync
 * transaction holds (lock-cycle risk aborts the deploy), so it skips
 * contended rows. No in-migration retry window can guarantee
 * convergence either: compose upgrades keep the PREVIOUS worker
 * container running — and starting fresh 60s page transactions —
 * until the new api reports healthy. The migration therefore parks
 * the loser -> canonical map in `migration_0062_asset_identity_retarget`
 * and this service, booting right after `migrate deploy` in the same
 * container command, retries in the background with unbounded
 * patience. It outlives the contention source: once the api is
 * healthy compose replaces the old worker, its transactions end, and
 * the drain converges. Registered via the shared PrismaModule, so the
 * new worker drains too — SKIP LOCKED plus tolerance for the table
 * vanishing make concurrent drainers race-safe.
 *
 * Every normal boot pays one `to_regclass` probe and exits. Each
 * round runs as three standalone statements (retarget, prune, count),
 * so row locks are held for milliseconds — unlike the migration's
 * single-transaction drain — and a stuck round can never wedge the
 * app. A binding that remains contended simply stays in the table
 * (its runs report `blocked`, see AssetsService) and the next round
 * or the next boot picks it up.
 */
@Injectable()
export class IdentityRetargetDrainService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(IdentityRetargetDrainService.name);
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;

  /** Delay between drain rounds while bindings remain contended. */
  static readonly ROUND_INTERVAL_MS = 2_000;
  /**
   * Consecutive failed rounds before giving up for this process
   * lifetime. The table is durable, so the next boot (or the sibling
   * process's drainer) resumes; a persistent failure at this cap is
   * an environment problem, not a contention problem.
   */
  static readonly MAX_CONSECUTIVE_FAILURES = 30;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    // Fire and forget — the drain must never delay app startup (the
    // old worker is only replaced once the api reports healthy, and
    // its replacement is what ends the contention being drained).
    void this.drain();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }

  private async drain(): Promise<void> {
    try {
      const pending = await this.pendingCount();
      if (pending === null) return; // no helper table — the normal boot
      if (pending > 0) {
        this.logger.warn(
          `Migration 0062 left ${pending} released duplicate asset(s) with sync records still bound ` +
            '(sync writers were active during deploy); draining in the background until every binding ' +
            'retargets to its canonical asset.',
        );
      }
      let failures = 0;
      while (!this.stopped) {
        try {
          const remaining = await this.drainRound();
          failures = 0;
          // null: the table vanished mid-round — a sibling drainer
          // (api vs worker) finished first. Nothing left to report.
          if (remaining === null) return;
          if (remaining === 0) {
            await this.dropHelperTable();
            this.logger.log(
              'Migration 0062 retarget backlog drained; helper table dropped.',
            );
            return;
          }
        } catch (error) {
          if (isUndefinedTableError(error)) {
            // A concurrent drainer (api vs worker) finished and
            // dropped the table between our statements — done.
            return;
          }
          failures += 1;
          this.logger.error(
            `Migration 0062 retarget drain round failed (${failures}/${IdentityRetargetDrainService.MAX_CONSECUTIVE_FAILURES}): ${String(error)}`,
          );
          if (failures >= IdentityRetargetDrainService.MAX_CONSECUTIVE_FAILURES) {
            this.logger.error(
              'Giving up on the migration 0062 retarget drain for this process; the helper table is retained ' +
                'and the drain resumes on the next api/worker start. Affected sync runs report blocked until then.',
            );
            return;
          }
        }
        await this.sleep(IdentityRetargetDrainService.ROUND_INTERVAL_MS);
      }
    } catch (error) {
      // Startup probe failed (e.g. database briefly unreachable).
      // Nothing is lost — the table is durable and the next boot
      // retries — but say so instead of dying silently.
      this.logger.error(
        `Migration 0062 retarget drain could not start: ${String(error)}`,
      );
    }
  }

  /**
   * Pending map rows, or null when the helper table does not exist.
   * The probe name is deliberately unqualified: the migration creates
   * the table in the connection's search_path schema (Prisma's
   * `?schema=` URL parameter, `public` only by default), and every
   * other statement here resolves the same way — a hardcoded
   * `public.` prefix would silently skip the drain on deployments
   * using a dedicated schema.
   */
  private async pendingCount(): Promise<number | null> {
    const [row] = await this.prisma.$queryRaw<
      { present: string | null }[]
    >`SELECT to_regclass('migration_0062_asset_identity_retarget')::text AS present`;
    if (row?.present == null) return null;
    const [count] = await this.prisma.$queryRaw<
      { pending: bigint }[]
    >`SELECT count(*) AS pending FROM "migration_0062_asset_identity_retarget"`;
    return Number(count?.pending ?? 0n);
  }

  /**
   * One drain round: retarget every currently-unlocked binding, prune
   * map rows whose bindings have all moved, report what remains.
   * Mirrors the migration's drain statements exactly (see the 0062
   * migration for why SKIP LOCKED and the retarget shape are what
   * they are). Returns null when the table vanished mid-round.
   */
  private async drainRound(): Promise<number | null> {
    await this.prisma.$executeRaw`
      UPDATE "integration_sync_records" AS record
      SET "asset_id" = map."canonical_id"
      FROM "migration_0062_asset_identity_retarget" AS map
      WHERE map."loser_id" = record."asset_id"
        AND record."id" IN (
          SELECT contended."id"
          FROM "integration_sync_records" AS contended
          JOIN "migration_0062_asset_identity_retarget" AS contended_map
            ON contended_map."loser_id" = contended."asset_id"
          FOR UPDATE OF contended SKIP LOCKED
        )`;
    await this.prisma.$executeRaw`
      DELETE FROM "migration_0062_asset_identity_retarget" AS map
      WHERE NOT EXISTS (
        SELECT 1
        FROM "integration_sync_records" AS record
        WHERE record."asset_id" = map."loser_id"
      )`;
    return this.pendingCount();
  }

  private async dropHelperTable(): Promise<void> {
    await this.prisma
      .$executeRaw`DROP TABLE IF EXISTS "migration_0062_asset_identity_retarget"`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
      this.timer.unref?.();
    });
  }
}

/**
 * Prisma wraps raw-query database errors as P2010 with the Postgres
 * SQLSTATE in `meta.code`; 42P01 is undefined_table. Duck-typed like
 * `isUniqueConstraintError` so specs need no generated error classes.
 */
function isUndefinedTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === 'P2010' && candidate.meta?.code === '42P01';
}
