import type { BackupJob } from '@weavestream/shared';
import { BackupWorker } from './backup.processor.js';

type RunPayload = Extract<BackupJob, { kind: 'run' }>;

/**
 * Regression for the disabled-schedule guard: a scheduler-fired tick
 * (no `backupRunId`) whose config was disabled must exit before it
 * creates a `BackupRun`, takes the advisory lock, or spawns pg_dump —
 * while manual jobs keep executing on disabled configs ("Run now" is
 * an explicit admin action).
 *
 * The "passed the guard" cases answer the advisory-lock probe with
 * `got: false`, so normal execution fails fast on the `concurrent`
 * branch instead of ever reaching a real `pg_dump` spawn.
 */
describe('BackupWorker handleRun disabled-schedule guard', () => {
  function makeWorker(opts: {
    enabled: boolean;
    manualRun?: { id: string } | null;
  }) {
    const cfg = {
      id: 'cfg-1',
      name: 'Nightly',
      enabled: opts.enabled,
      cron: '0 3 * * *',
      timezone: null,
      retention: { keepLast: 3, daily: 7, weekly: 4, monthly: 12 },
      notifyEmails: [] as string[],
      notifyOnSuccess: false,
    };
    const prisma = {
      backupConfig: {
        findUnique: jest.fn().mockResolvedValue(cfg),
        update: jest.fn().mockResolvedValue({}),
      },
      backupRun: {
        findUnique: jest.fn().mockResolvedValue(opts.manualRun ?? null),
        create: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'run-new',
            ...data,
          }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ got: false }];
        if (sql.includes('pg_advisory_unlock')) return [{ ok: true }];
        throw new Error(`unexpected raw sql: ${sql}`);
      }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const email = { send: jest.fn().mockResolvedValue(undefined) };
    const env = {
      values: { BACKUP_STORAGE_DIR: '/var/lib/weavestream/backup' },
    };
    const worker = new BackupWorker(
      // RedisService — only touched by start(), which these specs never call.
      {} as never,
      prisma as never,
      audit as never,
      email as never,
      env as never,
    );
    const run = (payload: RunPayload) =>
      (
        worker as unknown as { handleRun(p: RunPayload): Promise<void> }
      ).handleRun(payload);
    return { run, prisma, audit, email };
  }

  it('skips a scheduled tick for a disabled config before any run row, lock, or dump work', async () => {
    const { run, prisma, audit, email } = makeWorker({ enabled: false });

    await run({ kind: 'run', configId: 'cfg-1' });

    expect(prisma.backupRun.create).not.toHaveBeenCalled();
    expect(prisma.backupRun.findUnique).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('still executes a manual job whose schedule was disabled after it was queued', async () => {
    const { run, prisma } = makeWorker({
      enabled: false,
      manualRun: { id: 'run-77' },
    });

    await run({ kind: 'run', configId: 'cfg-1', backupRunId: 'run-77' });

    // Reached the advisory-lock probe → the guard let it through; the
    // fail-fast `concurrent` branch then marks the pre-allocated row.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prisma.backupRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-77' },
        data: expect.objectContaining({
          status: 'failed',
          error: 'concurrent',
        }),
      }),
    );
  });

  it('still executes a scheduled tick for an enabled config, minting the SCHEDULED row', async () => {
    const { run, prisma } = makeWorker({ enabled: true });

    await run({ kind: 'run', configId: 'cfg-1' });

    expect(prisma.backupRun.create).toHaveBeenCalledWith({
      data: { configId: 'cfg-1', kind: 'SCHEDULED', status: 'queued' },
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
