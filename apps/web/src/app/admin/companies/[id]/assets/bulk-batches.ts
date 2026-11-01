import type { BulkAssetResult } from '@weavestream/shared';

/** The part of an `apiFetch` result the batch loop reads. */
export type BulkBatchResponse = {
  ok: boolean;
  data: BulkAssetResult | null;
  problem?: unknown;
};

export type BulkBatchOutcome = {
  ok: BulkAssetResult['ok'];
  failed: BulkAssetResult['failed'];
  /**
   * Set when a request stopped the loop: a not-ok response (including a
   * cancelled step-up) or a thrown error such as a network failure.
   * `thrown` tells the caller which, so it can word the toast.
   */
  stopped: { problem: unknown; thrown: boolean } | null;
  /**
   * Ids to keep selected: every per-item failure, plus the batch that
   * stopped and every later batch. Only confirmed successes leave.
   */
  remaining: string[];
};

/**
 * Send a bulk asset action in batches of `batchSize`, because the API
 * rejects more ids than `BULK_ASSET_IDS_MAX` in one request (#97).
 *
 * Earlier batches have already been applied when a later one stops, so
 * the result always reports what was done. The batch that stopped stays
 * in `remaining` — dropping it would deselect assets nobody processed.
 * Same rule as `reportPartial` in `copy-assets-dialog.tsx`.
 */
export async function runInBatches(
  ids: string[],
  batchSize: number,
  send: (batch: string[]) => Promise<BulkBatchResponse>,
): Promise<BulkBatchOutcome> {
  // A bad step would silently send nothing (NaN) or never end (0).
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`runInBatches: invalid batch size ${String(batchSize)}`);
  }
  const ok: BulkAssetResult['ok'] = [];
  const failed: BulkAssetResult['failed'] = [];
  const outcome = (
    stopped: BulkBatchOutcome['stopped'],
    next: number,
  ): BulkBatchOutcome => ({
    ok,
    failed,
    stopped,
    remaining: [...failed.map((f) => f.id), ...ids.slice(next)],
  });

  for (let next = 0; next < ids.length; next += batchSize) {
    let res: BulkBatchResponse;
    try {
      res = await send(ids.slice(next, next + batchSize));
    } catch (err) {
      return outcome({ problem: err, thrown: true }, next);
    }
    if (!res.ok || !res.data) {
      return outcome({ problem: res.problem, thrown: false }, next);
    }
    ok.push(...res.data.ok);
    failed.push(...res.data.failed);
  }
  return outcome(null, ids.length);
}
