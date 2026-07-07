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
  orphanMinAgeHours?: number;
  /** On-disk upload dirs per company, for the WS-013 orphan pass. */
  orphanDirs?: Record<string, { uploadId: string; mtime: Date }[]>;
  /** uploadIds with a live `upload:pending:<id>` Redis session. */
  pendingIds?: string[];
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
      where: { deletedAt?: { lt: Date }; id?: { in: string[] } };
      take?: number;
    }): Promise<Array<Partial<FakeRow>>> => {
      // Orphan-pass lookup: any row (live or soft-deleted) counts.
      if (args.where.id) {
        const ids = new Set(args.where.id.in);
        return opts.rows
          .filter((r) => ids.has(r.id))
          .map((r) => ({ id: r.id }));
      }
      const cutoff = args.where.deletedAt!.lt;
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
  const orphanDirs = opts.orphanDirs ?? {};
  const listTenantDirs = jest.fn(async () => Object.keys(orphanDirs));
  const listUploadDirs = jest.fn(
    async (companyId: string) => orphanDirs[companyId] ?? [],
  );
  const removedDirs: string[] = [];
  const removeUploadDir = jest.fn(
    async (companyId: string, uploadId: string) => {
      removedDirs.push(`${companyId}/${uploadId}`);
    },
  );
  const storage = {
    deleteObject,
    removeUploadDirIfEmpty,
    listTenantDirs,
    listUploadDirs,
    removeUploadDir,
  };

  const auditLog = jest.fn(async () => undefined);
  const audit = { log: auditLog };

  const env = {
    values: {
      UPLOAD_REAPER_RETENTION_DAYS: opts.retentionDays ?? RETENTION_DAYS,
      UPLOAD_REAPER_BATCH_SIZE: opts.batchSize ?? BATCH_SIZE,
      UPLOAD_ORPHAN_MIN_AGE_HOURS: opts.orphanMinAgeHours ?? 24,
    },
  };

  const pending = new Set(
    (opts.pendingIds ?? []).map((id) => `upload:pending:${id}`),
  );
  const redisExists = jest.fn(async (key: string) => (pending.has(key) ? 1 : 0));
  const redis = {
    bullmqConnection: () => ({}),
    client: { exists: redisExists },
  };

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
    listTenantDirs,
    listUploadDirs,
    removeUploadDir,
    removedDirs,
    redisExists,
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

describe('UploadReaperWorker.sweep — WS-013 orphan pass', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const old = (hours: number) => new Date(Date.now() - hours * HOUR_MS);

  it('removes an old directory with no DB row and no pending session', async () => {
    const ctx = makeWorker({
      rows: [],
      orphanDirs: { c1: [{ uploadId: 'u-orphan', mtime: old(48) }] },
    });
    const result = await ctx.worker.sweep();

    expect(ctx.removedDirs).toEqual(['c1/u-orphan']);
    expect(result.orphanScanned).toBe(1);
    expect(result.orphanRemoved).toBe(1);
    expect(result.orphanSkipped).toBe(0);
    expect(result.orphanFailed).toBe(0);
    expect(ctx.auditLog.mock.calls[0][0].after).toMatchObject({
      orphanRemoved: 1,
    });
  });

  it('keeps directories that have a DB row, even a soft-deleted one', async () => {
    const ctx = makeWorker({
      rows: [
        row({ id: 'u-live', deletedAt: null }),
        row({ id: 'u-tombstone', deletedAt: new Date() }),
      ],
      orphanDirs: {
        c1: [
          { uploadId: 'u-live', mtime: old(48) },
          { uploadId: 'u-tombstone', mtime: old(48) },
        ],
      },
    });
    const result = await ctx.worker.sweep();

    expect(ctx.removedDirs).toEqual([]);
    expect(result.orphanScanned).toBe(2);
    expect(result.orphanSkipped).toBe(2);
    expect(result.orphanRemoved).toBe(0);
  });

  it('keeps a directory with a live pending Redis session', async () => {
    const ctx = makeWorker({
      rows: [],
      orphanDirs: { c1: [{ uploadId: 'u-pending', mtime: old(48) }] },
      pendingIds: ['u-pending'],
    });
    const result = await ctx.worker.sweep();

    expect(ctx.redisExists).toHaveBeenCalledWith('upload:pending:u-pending');
    expect(ctx.removedDirs).toEqual([]);
    expect(result.orphanSkipped).toBe(1);
    expect(result.orphanRemoved).toBe(0);
  });

  it('keeps directories younger than the minimum age', async () => {
    const ctx = makeWorker({
      rows: [],
      orphanMinAgeHours: 24,
      orphanDirs: { c1: [{ uploadId: 'u-young', mtime: old(2) }] },
    });
    const result = await ctx.worker.sweep();

    expect(ctx.removedDirs).toEqual([]);
    expect(result.orphanScanned).toBe(0);
    expect(result.orphanRemoved).toBe(0);
  });

  it('shares the batch budget with the row reap', async () => {
    // batchSize=2: the row reap consumes 2, leaving no budget for the
    // orphan pass; nothing on disk is touched this tick.
    const staleRows = [0, 1].map((i) =>
      row({
        id: `u-row-${i}`,
        deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS - i * 1000),
      }),
    );
    const ctx = makeWorker({
      rows: staleRows,
      batchSize: 2,
      orphanDirs: { c1: [{ uploadId: 'u-orphan', mtime: old(48) }] },
    });
    const result = await ctx.worker.sweep();

    expect(result.reaped).toBe(2);
    expect(ctx.removedDirs).toEqual([]);
    expect(result.orphanRemoved).toBe(0);
    expect(ctx.listTenantDirs).not.toHaveBeenCalled();
  });

  it('caps orphan removals at the remaining budget', async () => {
    const dirs = Array.from({ length: 5 }, (_, i) => ({
      uploadId: `u-orphan-${i}`,
      mtime: old(48),
    }));
    const ctx = makeWorker({
      rows: [
        row({
          id: 'u-row',
          deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS),
        }),
      ],
      batchSize: 3,
      orphanDirs: { c1: dirs },
    });
    const result = await ctx.worker.sweep();

    // 1 row reaped leaves budget for 2 orphan removals.
    expect(result.reaped).toBe(1);
    expect(result.orphanRemoved).toBe(2);
    expect(ctx.removedDirs).toHaveLength(2);
  });

  it('counts a failed removal and keeps sweeping', async () => {
    const ctx = makeWorker({
      rows: [],
      orphanDirs: {
        c1: [
          { uploadId: 'u-bad', mtime: old(48) },
          { uploadId: 'u-good', mtime: old(48) },
        ],
      },
    });
    ctx.removeUploadDir.mockImplementationOnce(async () => {
      throw new Error('EACCES');
    });
    const result = await ctx.worker.sweep();

    expect(result.orphanFailed).toBe(1);
    expect(result.orphanRemoved).toBe(1);
    expect(ctx.removedDirs).toEqual(['c1/u-good']);
  });

  it('does no orphan work when the advisory lock is held', async () => {
    const ctx = makeWorker({
      rows: [],
      lockGot: false,
      orphanDirs: { c1: [{ uploadId: 'u-orphan', mtime: old(48) }] },
    });
    const result = await ctx.worker.sweep();

    expect(result.skipped).toBe('concurrent');
    expect(ctx.listTenantDirs).not.toHaveBeenCalled();
    expect(ctx.removedDirs).toEqual([]);
  });
});
