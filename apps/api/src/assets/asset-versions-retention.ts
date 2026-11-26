import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

export const ASSET_VERSION_RETENTION_MAX_DAYS = 3650;

export interface PruneAssetVersionsResult {
  cutoff: Date;
  /** Rows that are older than the cutoff and not protected. */
  eligible: number;
  /** Rows actually deleted (0 for a dry run). */
  deleted: number;
}

/**
 * Retention prune for `asset_versions`: delete versions created before
 * `now - olderThanDays`, EXCEPT the first (origin/baseline) and the latest
 * version of every asset. This is a maintenance job across all tenants, so
 * it runs as raw SQL outside the request tenant scope and is only ever
 * reachable from the operator CLI (`prune-asset-versions`).
 *
 * There is no audit-log retention setting to mirror (the audit log is
 * append-only and never auto-pruned) and no scheduled-maintenance runner for
 * it, so this is a function plus a CLI command; the operator schedules it
 * (cron) if they want a retention window.
 */
export async function pruneAssetVersions(
  prisma: Pick<PrismaService, '$queryRaw' | '$executeRaw'>,
  opts: { olderThanDays: number; dryRun: boolean; now?: Date },
): Promise<PruneAssetVersionsResult> {
  const days = opts.olderThanDays;
  if (!Number.isInteger(days) || days < 1 || days > ASSET_VERSION_RETENTION_MAX_DAYS) {
    throw new RangeError(
      `olderThanDays must be an integer between 1 and ${ASSET_VERSION_RETENTION_MAX_DAYS}`,
    );
  }
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000);
  const protectedFilter = Prisma.sql`v.created_at < ${cutoff}
      AND v.version > (SELECT min(m.version) FROM asset_versions m WHERE m.asset_id = v.asset_id)
      AND v.version < (SELECT max(m.version) FROM asset_versions m WHERE m.asset_id = v.asset_id)`;
  if (opts.dryRun) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT count(*) AS n FROM asset_versions v WHERE ${protectedFilter}`;
    return { cutoff, eligible: Number(rows[0]?.n ?? 0), deleted: 0 };
  }
  const deleted = await prisma.$executeRaw`
    DELETE FROM asset_versions v WHERE ${protectedFilter}`;
  return { cutoff, eligible: deleted, deleted };
}
