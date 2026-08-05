import { BackupJobNames } from '@weavestream/shared';
import { BackupQueueRegistrar } from './backup-queue.registrar.js';

/**
 * The registrar's whole job is Redis-side bookkeeping, so these specs
 * pin the BullMQ call shapes: which scheduler ids get removed, what
 * `upsertJobScheduler` receives, and — critically — the boot ordering
 * invariant (scheduler removals → legacy sweep → registrations),
 * because schedulers and legacy repeatables share one Redis zset and
 * `removeRepeatableByKey` would delete a just-registered scheduler.
 */
describe('BackupQueueRegistrar', () => {
  interface ConfigRow {
    id: string;
    cron: string;
    timezone: string | null;
    enabled: boolean;
  }

  function setup(opts: {
    schedulers?: Array<{ id?: string; key?: string }>;
    repeatables?: Array<{ key: string }>;
    configs?: ConfigRow[];
    config?: ConfigRow | null;
  } = {}) {
    const queue = {
      getJobSchedulers: jest.fn().mockResolvedValue(opts.schedulers ?? []),
      removeJobScheduler: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue(opts.repeatables ?? []),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      backupConfig: {
        findMany: jest.fn().mockResolvedValue(opts.configs ?? []),
        findUnique: jest.fn().mockResolvedValue(opts.config ?? null),
      },
    };
    const queues = { get: jest.fn(() => queue) };
    const registrar = new BackupQueueRegistrar(
      prisma as never,
      queues as never,
    );
    const logger = (
      registrar as unknown as {
        logger: { error: (msg: string) => void; log: (msg: string) => void };
      }
    ).logger;
    const errorSpy = jest
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    return { registrar, queue, prisma, errorSpy };
  }

  const first = (fn: jest.Mock) => Math.min(...fn.mock.invocationCallOrder);
  const last = (fn: jest.Mock) => Math.max(...fn.mock.invocationCallOrder);

  describe('onApplicationBootstrap', () => {
    it('removes backup-config-* schedulers (also when listed under `key` only), sweeps every legacy repeatable, and asks only for enabled configs', async () => {
      const { registrar, queue, prisma } = setup({
        schedulers: [
          // BullMQ 5.76 lists schedulers under `key`, not `id`.
          { key: 'backup-config-cfg-a' },
          { id: 'backup-config-cfg-b', key: 'ignored-when-id-present' },
          // Legacy-shaped zset member — not ours, left to the sweep.
          { key: '3f2a9c81d4be5f6a7c8d9e0f3f2a9c81' },
        ],
        repeatables: [{ key: 'legacy-md5-one' }, { key: 'legacy-md5-two' }],
        configs: [
          { id: 'cfg-1', cron: '0 3 * * *', timezone: null, enabled: true },
        ],
      });

      await registrar.onApplicationBootstrap();

      expect(queue.removeJobScheduler.mock.calls.map((c) => c[0])).toEqual([
        'backup-config-cfg-a',
        'backup-config-cfg-b',
      ]);
      expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
        'legacy-md5-one',
        'legacy-md5-two',
      ]);
      expect(prisma.backupConfig.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
      });
      expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    });

    it('registers enabled configs with pinned scheduler id, cron, timezone (Etc/UTC fallback), job name, and payload', async () => {
      const { registrar, queue } = setup({
        configs: [
          { id: 'cfg-1', cron: '0 3 * * *', timezone: null, enabled: true },
          {
            id: 'cfg-2',
            cron: '30 4 * * *',
            timezone: 'America/New_York',
            enabled: true,
          },
        ],
      });

      await registrar.onApplicationBootstrap();

      expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
        1,
        'backup-config-cfg-1',
        { pattern: '0 3 * * *', tz: 'Etc/UTC' },
        {
          name: BackupJobNames.run,
          data: { kind: 'run', configId: 'cfg-1' },
        },
      );
      expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
        2,
        'backup-config-cfg-2',
        { pattern: '30 4 * * *', tz: 'America/New_York' },
        {
          name: BackupJobNames.run,
          data: { kind: 'run', configId: 'cfg-2' },
        },
      );
    });

    it('orders the pass: all scheduler removals, then all legacy removals, then the first upsert', async () => {
      const { registrar, queue } = setup({
        schedulers: [
          { key: 'backup-config-a' },
          { key: 'backup-config-b' },
        ],
        repeatables: [{ key: 'legacy-1' }, { key: 'legacy-2' }],
        configs: [
          { id: 'cfg-1', cron: '0 3 * * *', timezone: null, enabled: true },
        ],
      });

      await registrar.onApplicationBootstrap();

      expect(last(queue.removeJobScheduler)).toBeLessThan(
        first(queue.removeRepeatableByKey),
      );
      expect(last(queue.removeRepeatableByKey)).toBeLessThan(
        first(queue.upsertJobScheduler),
      );
    });

    it('logs and aborts before any registration when the sweep fails', async () => {
      const { registrar, queue, prisma, errorSpy } = setup({
        schedulers: [{ key: 'backup-config-a' }],
        configs: [
          { id: 'cfg-1', cron: '0 3 * * *', timezone: null, enabled: true },
        ],
      });
      queue.removeJobScheduler.mockRejectedValueOnce(new Error('redis gone'));

      await expect(registrar.onApplicationBootstrap()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('redis gone'),
      );
      expect(prisma.backupConfig.findMany).not.toHaveBeenCalled();
      expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });

    it('isolates a single failing registration: logs it and still registers the rest', async () => {
      const { registrar, queue, errorSpy } = setup({
        configs: [
          { id: 'cfg-bad', cron: '0 3 * * *', timezone: null, enabled: true },
          {
            id: 'cfg-good',
            cron: '15 3 * * *',
            timezone: null,
            enabled: true,
          },
        ],
      });
      queue.upsertJobScheduler.mockRejectedValueOnce(
        new Error('constraint error'),
      );

      await expect(registrar.onApplicationBootstrap()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('cfg-bad'),
      );
      expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(queue.upsertJobScheduler).toHaveBeenLastCalledWith(
        'backup-config-cfg-good',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('reassert', () => {
    it('removes then re-upserts an enabled config, in that order', async () => {
      const { registrar, queue } = setup({
        config: {
          id: 'cfg-1',
          cron: '0 5 * * *',
          timezone: 'Europe/Berlin',
          enabled: true,
        },
      });

      await registrar.reassert('cfg-1');

      expect(queue.removeJobScheduler).toHaveBeenCalledWith(
        'backup-config-cfg-1',
      );
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        'backup-config-cfg-1',
        { pattern: '0 5 * * *', tz: 'Europe/Berlin' },
        {
          name: BackupJobNames.run,
          data: { kind: 'run', configId: 'cfg-1' },
        },
      );
      expect(last(queue.removeJobScheduler)).toBeLessThan(
        first(queue.upsertJobScheduler),
      );
    });

    it('removes without re-registering when the config is disabled', async () => {
      const { registrar, queue } = setup({
        config: {
          id: 'cfg-1',
          cron: '0 5 * * *',
          timezone: null,
          enabled: false,
        },
      });

      await registrar.reassert('cfg-1');

      expect(queue.removeJobScheduler).toHaveBeenCalledWith(
        'backup-config-cfg-1',
      );
      expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });

    it('removes without re-registering when the config was deleted', async () => {
      const { registrar, queue } = setup({ config: null });

      await registrar.reassert('cfg-1');

      expect(queue.removeJobScheduler).toHaveBeenCalledWith(
        'backup-config-cfg-1',
      );
      expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });

    it('logs a removal failure, skips the upsert, and never throws at the CRUD boundary', async () => {
      const { registrar, queue, prisma, errorSpy } = setup({
        config: {
          id: 'cfg-1',
          cron: '0 5 * * *',
          timezone: null,
          enabled: true,
        },
      });
      queue.removeJobScheduler.mockRejectedValueOnce(
        new Error('redis hiccup'),
      );

      await expect(registrar.reassert('cfg-1')).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('redis hiccup'),
      );
      expect(prisma.backupConfig.findUnique).not.toHaveBeenCalled();
      expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });
  });
});
