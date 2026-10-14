import {
  registerCronScheduler,
  removeJobSchedulers,
  removeRepeatables,
} from './repeatable-registration.js';
import type { Queue, RepeatableJob } from 'bullmq';

const repeatable = (over: Partial<RepeatableJob>): RepeatableJob => ({
  key: 'k',
  name: 'scheduled',
  id: null,
  endDate: null,
  tz: null,
  pattern: '* * * * *',
  ...over,
});

/**
 * BullMQ 5.76 lists Job Schedulers with `key` set and `id` often absent, so
 * both fields are optional here on purpose — that asymmetry is what
 * `removeJobSchedulers` exists to absorb. `iterationCount` is set on real
 * schedulers only; legacy entries in the shared zset are listed without it.
 */
type SchedulerEntry = { id?: string; key?: string; iterationCount?: number };

function makeQueue(
  entries: RepeatableJob[] = [],
  // `undefined` is what BullMQ lists for an entry removed between its zset
  // read and its hash read (another API replica booting at the same time).
  schedulers: (SchedulerEntry | undefined)[] = [],
) {
  const queue = {
    getRepeatableJobs: jest.fn().mockResolvedValue(entries),
    removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    getJobSchedulers: jest.fn().mockResolvedValue(schedulers),
    removeJobScheduler: jest.fn().mockResolvedValue(undefined),
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  };
  return queue as unknown as Queue & typeof queue;
}

const makeLogger = () => ({ log: jest.fn(), warn: jest.fn() });

describe('removeRepeatables', () => {
  it('removes every legacy entry', async () => {
    const queue = makeQueue([
      repeatable({ key: 'a' }),
      repeatable({ key: 'b' }),
    ]);

    await removeRepeatables(queue, { onError: 'skip', onSkipped: jest.fn() });

    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      'a',
      'b',
    ]);
  });

  it('leaves Job Schedulers alone, whether listed under `id` or `key`', async () => {
    // Schedulers and legacy entries share 1 zset, so `getRepeatableJobs()`
    // lists both. Removing a scheduler here would drop a live schedule.
    const queue = makeQueue(
      [
        repeatable({ key: 'alerts:scan', name: 'scan' }),
        repeatable({ key: 'backup-config-a', name: 'run' }),
        repeatable({ key: '3f2a9c81d4be5f6a7c8d9e0f3f2a9c81', name: 'scan' }),
      ],
      [
        { key: 'alerts:scan', iterationCount: 4 },
        { id: 'backup-config-a', key: 'backup-config-a', iterationCount: 1 },
        // The legacy md5 entry, as `getJobSchedulers()` lists it: no `ic`.
        { key: '3f2a9c81d4be5f6a7c8d9e0f3f2a9c81' },
      ],
    );

    await removeRepeatables(queue, { onError: 'throw' });

    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      '3f2a9c81d4be5f6a7c8d9e0f3f2a9c81',
    ]);
  });

  it('skips an entry another replica removed mid-listing', async () => {
    const queue = makeQueue(
      [repeatable({ key: 'alerts:scan' }), repeatable({ key: 'legacy-md5' })],
      [{ key: 'alerts:scan', iterationCount: 3 }, undefined],
    );

    await expect(
      removeRepeatables(queue, { onError: 'throw' }),
    ).resolves.toBeUndefined();

    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      'legacy-md5',
    ]);
  });

  it("reports a stuck key and keeps going under 'skip'", async () => {
    const queue = makeQueue([repeatable({ key: 'a' }), repeatable({ key: 'b' })]);
    const err = new Error('redis gone');
    queue.removeRepeatableByKey.mockRejectedValueOnce(err);
    const onSkipped = jest.fn();

    await expect(
      removeRepeatables(queue, { onError: 'skip', onSkipped }),
    ).resolves.toBeUndefined();

    // Best-effort, but never silent: a surviving entry keeps firing, so the
    // pass must continue AND say which key it gave up on.
    expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(2);
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith('a', err);
  });

  it("propagates and stops on the first failure under 'throw'", async () => {
    const queue = makeQueue([repeatable({ key: 'a' }), repeatable({ key: 'b' })]);
    queue.removeRepeatableByKey.mockRejectedValueOnce(new Error('redis gone'));

    // BackupQueueRegistrar depends on this: a surviving legacy entry beside a
    // fresh scheduler is the double-fire bug, so the caller must abort.
    await expect(removeRepeatables(queue, { onError: 'throw' })).rejects.toThrow(
      'redis gone',
    );
    expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(1);
  });

  it('propagates a failing listing under both policies', async () => {
    for (const opts of [
      { onError: 'skip', onSkipped: jest.fn() },
      { onError: 'throw' },
    ] as const) {
      for (const listing of ['getRepeatableJobs', 'getJobSchedulers'] as const) {
        const queue = makeQueue([repeatable({ key: 'a' })]);
        queue[listing].mockRejectedValue(new Error('listing failed'));
        await expect(removeRepeatables(queue, opts)).rejects.toThrow(
          'listing failed',
        );
        expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
      }
    }
  });
});

describe('removeJobSchedulers', () => {
  const prefixed = (id: string) => id.startsWith('backup-config-');

  it('resolves entries listed under `key` only', async () => {
    // The BullMQ 5.76 shape: `key` set, `id` absent entirely.
    const queue = makeQueue([], [{ key: 'backup-config-a' }]);

    await removeJobSchedulers(queue, { onError: 'throw', match: prefixed });

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('backup-config-a');
  });

  it('prefers `id` over `key` when both are present', async () => {
    const queue = makeQueue(
      [],
      [{ id: 'backup-config-b', key: 'ignored-when-id-present' }],
    );

    await removeJobSchedulers(queue, { onError: 'throw', match: prefixed });

    expect(queue.removeJobScheduler.mock.calls.map((c) => c[0])).toEqual([
      'backup-config-b',
    ]);
  });

  it('leaves non-matching and unidentifiable entries alone, in listing order', async () => {
    const queue = makeQueue(
      [],
      [
        { key: 'backup-config-a' },
        // A legacy-shaped zset member — an opaque md5, not ours.
        { key: '3f2a9c81d4be5f6a7c8d9e0f3f2a9c81' },
        {},
        // Removed by another replica between BullMQ's zset and hash reads.
        undefined,
        { key: 'backup-config-b' },
      ],
    );

    await removeJobSchedulers(queue, { onError: 'throw', match: prefixed });

    expect(queue.removeJobScheduler.mock.calls.map((c) => c[0])).toEqual([
      'backup-config-a',
      'backup-config-b',
    ]);
  });

  it("reports a stuck id and keeps going under 'skip'", async () => {
    const queue = makeQueue(
      [],
      [{ key: 'backup-config-a' }, { key: 'backup-config-b' }],
    );
    const err = new Error('redis gone');
    queue.removeJobScheduler.mockRejectedValueOnce(err);
    const onSkipped = jest.fn();

    await expect(
      removeJobSchedulers(queue, { onError: 'skip', onSkipped, match: prefixed }),
    ).resolves.toBeUndefined();

    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(2);
    expect(onSkipped).toHaveBeenCalledWith('backup-config-a', err);
  });

  it("propagates and stops on the first failure under 'throw'", async () => {
    const queue = makeQueue(
      [],
      [{ key: 'backup-config-a' }, { key: 'backup-config-b' }],
    );
    queue.removeJobScheduler.mockRejectedValueOnce(new Error('redis gone'));

    // BackupQueueRegistrar aborts its whole pass on this, rather than
    // register a fresh scheduler next to one it failed to clear.
    await expect(
      removeJobSchedulers(queue, { onError: 'throw', match: prefixed }),
    ).rejects.toThrow('redis gone');
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('propagates a failing listing under both policies', async () => {
    for (const policy of [
      { onError: 'skip', onSkipped: jest.fn() },
      { onError: 'throw' },
    ] as const) {
      const queue = makeQueue();
      queue.getJobSchedulers.mockRejectedValue(new Error('listing failed'));
      await expect(
        removeJobSchedulers(queue, { ...policy, match: prefixed }),
      ).rejects.toThrow('listing failed');
    }
  });
});

describe('registerCronScheduler', () => {
  const base = {
    jobId: 'domain-checks:scheduled',
    jobName: 'scheduled',
    data: { kind: 'scheduled' },
    label: 'domain-checks',
    disabledMessage: 'DOMAIN_CHECK_CRON=off — scheduled domain checks disabled.',
  };

  it('clears legacy entries, then upserts the current cron as a Job Scheduler', async () => {
    const queue = makeQueue(
      [
        repeatable({ key: 'legacy-md5', name: 'scheduled' }),
        repeatable({ key: base.jobId, name: 'scheduled' }),
      ],
      [{ key: base.jobId, iterationCount: 2 }, { key: 'legacy-md5' }],
    );
    const logger = makeLogger();

    await registerCronScheduler({ ...base, queue, logger, cron: '17 3 * * *' });

    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      'legacy-md5',
    ]);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'domain-checks:scheduled',
      { pattern: '17 3 * * *' },
      { name: 'scheduled', data: { kind: 'scheduled' } },
    );
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      'Registered scheduled domain-checks job with cron "17 3 * * *"',
    );
  });

  it('sweeps before it upserts', async () => {
    const queue = makeQueue([repeatable({ key: 'legacy-md5' })]);

    await registerCronScheduler({
      ...base,
      queue,
      logger: makeLogger(),
      cron: '17 3 * * *',
    });

    // A legacy entry left beside the fresh scheduler would double-fire.
    expect(
      Math.max(...queue.removeRepeatableByKey.mock.invocationCallOrder),
    ).toBeLessThan(Math.min(...queue.upsertJobScheduler.mock.invocationCallOrder));
  });

  it("removes the lane's scheduler and warns when the cron is 'off'", async () => {
    const queue = makeQueue([repeatable({ key: 'legacy-md5' })]);
    const logger = makeLogger();

    await registerCronScheduler({ ...base, queue, logger, cron: 'off' });

    // The sweep still runs, so toggling a lane off also clears its leftovers.
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('legacy-md5');
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(base.jobId);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(base.disabledMessage);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('warns about a stuck legacy key and still registers', async () => {
    const queue = makeQueue([repeatable({ key: 'legacy-md5' })]);
    queue.removeRepeatableByKey.mockRejectedValueOnce(new Error('redis gone'));
    const logger = makeLogger();

    await registerCronScheduler({ ...base, queue, logger, cron: '17 3 * * *' });

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    // The leftover will double-fire until the next restart, so it must not be
    // discarded the way the pre-helper `.catch(() => undefined)` discarded it.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove a legacy domain-checks repeatable'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('redis gone'),
    );
  });
});
