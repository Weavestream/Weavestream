import { UploadReaperWorker } from './upload-reaper.processor.js';

const RETENTION_DAYS = 30;
const BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

interface FakeRow {
  id: string;
  companyId: string;
  storageKey: string;
  thumbnailKey: string | null;
  sizeBytes: number;
  deletedAt: Date | null;
}

function makeWorker(opts: {
  rows: FakeRow[];
  lockGot?: boolean;
  storageBehavior?: {
    deleteObjectImpl?: (companyId: string, key: string) => Promise<void>;
  };
  retentionDays?: number;
  batchSize?: number;
}) {
  const lockGot = opts.lockGot ?? true;
  const queryRawUnsafe = jest.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return [{ got: lockGot }] as never;
    }
    if (sql.includes('pg_advisory_unlock')) {
      return [{ pg_advisory_unlock: true }] as never;
    }
    throw new Error(`unexpected raw sql: ${sql}`);
  });

  const findMany = jest.fn(
    async (args: {
      where: { deletedAt: { lt: Date } };
      take: number;
    }): Promise<FakeRow[]> => {
      const cutoff = args.where.deletedAt.lt;
      const matched = opts.rows
        .filter((r) => r.deletedAt !== null && r.deletedAt.getTime() < cutoff.getTime())
        .sort((a, b) => (a.deletedAt!.getTime() - b.deletedAt!.getTime()))
        .slice(0, args.take);
      return matched.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        storageKey: r.storageKey,
        thumbnailKey: r.thumbnailKey,
        sizeBytes: r.sizeBytes,
        deletedAt: r.deletedAt,
      }));
    },
  );

  const deletedIds: string[] = [];
  const deleteRow = jest.fn(async (args: { where: { id: string } }) => {
    deletedIds.push(args.where.id);
    return { id: args.where.id } as never;
  });

  const prisma = {
    $queryRawUnsafe: queryRawUnsafe,
    upload: { findMany, delete: deleteRow },
  };

  const deleteObject = jest.fn(
    opts.storageBehavior?.deleteObjectImpl ??
      (async (_companyId: string, _key: string) => {
        return undefined;
      }),
  );
  const removeUploadDirIfEmpty = jest.fn(async () => undefined);
  const storage = { deleteObject, removeUploadDirIfEmpty };

  const auditLog = jest.fn(async () => undefined);
  const audit = { log: auditLog };

  const env = {
    values: {
      UPLOAD_REAPER_RETENTION_DAYS: opts.retentionDays ?? RETENTION_DAYS,
      UPLOAD_REAPER_BATCH_SIZE: opts.batchSize ?? BATCH_SIZE,
    },
  };

  const redis = { bullmqConnection: () => ({}) };

  const worker = new UploadReaperWorker(
    env as never,
    redis as never,
    prisma as never,
    storage as never,
    audit as never,
  );

  return {
    worker,
    prisma,
    storage,
    audit,
    auditLog,
    deleteRow,
    deleteObject,
    removeUploadDirIfEmpty,
    findMany,
    queryRawUnsafe,
    deletedIds,
  };
}

function row(over: Partial<FakeRow> & { id: string; deletedAt: Date | null }): FakeRow {
  return {
    companyId: 'c1',
    storageKey: `c1/uploads/${over.id}/file.bin`,
    thumbnailKey: null,
    sizeBytes: 1024,
    ...over,
  };
}

describe('UploadReaperWorker.sweep', () => {
  it('reaps rows older than the cutoff and leaves fresh ones alone', async () => {
    const now = Date.now();
    const stale = row({
      id: 'u-stale',
      deletedAt: new Date(now - (RETENTION_DAYS + 5) * DAY_MS),
      thumbnailKey: 'c1/thumbs/u-stale.webp',
      sizeBytes: 2048,
    });
    const fresh = row({
      id: 'u-fresh',
      deletedAt: new Date(now - 1 * DAY_MS),
      sizeBytes: 4096,
    });
    const live = row({ id: 'u-live', deletedAt: null });

    const ctx = makeWorker({ rows: [stale, fresh, live] });
    const result = await ctx.worker.sweep();

    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.scanned).toBe(1);
    expect(result.bytesFreed).toBe(2048);
    expect(result.retentionDays).toBe(RETENTION_DAYS);
    expect(result.skipped).toBeUndefined();

    expect(ctx.deletedIds).toEqual(['u-stale']);
    expect(ctx.deleteObject).toHaveBeenCalledWith('c1', stale.storageKey);
    expect(ctx.deleteObject).toHaveBeenCalledWith('c1', 'c1/thumbs/u-stale.webp');
    expect(ctx.removeUploadDirIfEmpty).toHaveBeenCalledWith('c1', 'u-stale');
    expect(ctx.auditLog).toHaveBeenCalledTimes(1);
    expect(ctx.auditLog.mock.calls[0][0]).toMatchObject({
      action: 'upload.reap',
      actorId: null,
      entityType: 'Upload',
      entityId: null,
      after: expect.objectContaining({ reaped: 1, failed: 0 }),
    });
  });

  it('does not call deleteObject for thumbnailKey when none is set', async () => {
    const stale = row({
      id: 'u-no-thumb',
      deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS),
      thumbnailKey: null,
    });
    const ctx = makeWorker({ rows: [stale] });
    await ctx.worker.sweep();

    expect(ctx.deleteObject).toHaveBeenCalledTimes(1);
    expect(ctx.deleteObject).toHaveBeenCalledWith('c1', stale.storageKey);
    expect(ctx.deletedIds).toEqual(['u-no-thumb']);
  });

  it('skips DB delete when storage delete fails so the next tick can retry', async () => {
    const stale = row({
      id: 'u-storage-fail',
      deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS),
    });
    const ctx = makeWorker({
      rows: [stale],
      storageBehavior: {
        deleteObjectImpl: async () => {
          throw new Error('disk EIO');
        },
      },
    });
    const result = await ctx.worker.sweep();

    expect(result.reaped).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.bytesFreed).toBe(0);
    expect(ctx.deleteRow).not.toHaveBeenCalled();
    expect(ctx.auditLog).toHaveBeenCalledTimes(1);
    expect(ctx.auditLog.mock.calls[0][0].after).toMatchObject({
      reaped: 0,
      failed: 1,
    });
  });

  it('continues processing remaining rows when one fails', async () => {
    const cutoffDelta = (RETENTION_DAYS + 2) * DAY_MS;
    const bad = row({
      id: 'u-bad',
      deletedAt: new Date(Date.now() - cutoffDelta),
    });
    const good = row({
      id: 'u-good',
      deletedAt: new Date(Date.now() - cutoffDelta + 1000),
      sizeBytes: 777,
    });
    let firstCall = true;
    const ctx = makeWorker({
      rows: [bad, good],
      storageBehavior: {
        deleteObjectImpl: async (_company, key) => {
          if (firstCall && key.includes('u-bad')) {
            firstCall = false;
            throw new Error('bad row');
          }
        },
      },
    });
    const result = await ctx.worker.sweep();

    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.bytesFreed).toBe(777);
    expect(ctx.deletedIds).toEqual(['u-good']);
  });

  it('respects the batch-size cap', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({
        id: `u-${i}`,
        deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS - i * 1000),
      }),
    );
    const ctx = makeWorker({ rows, batchSize: 3 });
    const result = await ctx.worker.sweep();

    expect(result.scanned).toBe(3);
    expect(result.reaped).toBe(3);
    expect(ctx.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3 }),
    );
    expect(ctx.deletedIds).toHaveLength(3);
  });

  it('returns skipped=concurrent and does no work when the advisory lock is held', async () => {
    const stale = row({
      id: 'u-locked',
      deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS),
    });
    const ctx = makeWorker({ rows: [stale], lockGot: false });
    const result = await ctx.worker.sweep();

    expect(result.skipped).toBe('concurrent');
    expect(result.reaped).toBe(0);
    expect(result.scanned).toBe(0);
    expect(ctx.findMany).not.toHaveBeenCalled();
    expect(ctx.deleteObject).not.toHaveBeenCalled();
    expect(ctx.deleteRow).not.toHaveBeenCalled();
    expect(ctx.auditLog).not.toHaveBeenCalled();
  });

  it('releases the advisory lock even when a row fails catastrophically', async () => {
    const stale = row({
      id: 'u-catastrophic',
      deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS),
    });
    const ctx = makeWorker({
      rows: [stale],
      storageBehavior: {
        deleteObjectImpl: async () => {
          throw new Error('catastrophic');
        },
      },
    });

    await ctx.worker.sweep();
    const unlockCalled = ctx.queryRawUnsafe.mock.calls.some((c) =>
      String(c[0]).includes('pg_advisory_unlock'),
    );
    expect(unlockCalled).toBe(true);
  });

  it('uses the configured retention window when computing cutoff', async () => {
    const ctx = makeWorker({
      rows: [],
      retentionDays: 7,
    });
    await ctx.worker.sweep();

    expect(ctx.findMany).toHaveBeenCalledTimes(1);
    const args = ctx.findMany.mock.calls[0][0] as {
      where: { deletedAt: { lt: Date } };
    };
    const cutoff = args.where.deletedAt.lt;
    const expected = Date.now() - 7 * DAY_MS;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
  });
});
