import {
  registerRepeatableCron,
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
 * `removeJobSchedulers` exists to absorb.
 */
type SchedulerEntry = { id?: string; key?: string };

function makeQueue(
  entries: RepeatableJob[] = [],
  schedulers: SchedulerEntry[] = [],
) {
  const queue = {
    getRepeatableJobs: jest.fn().mockResolvedValue(entries),
    removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    getJobSchedulers: jest.fn().mockResolvedValue(schedulers),
    removeJobScheduler: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
  };
  return queue as unknown as Queue & typeof queue;
}

const makeLogger = () => ({ log: jest.fn(), warn: jest.fn() });

describe('removeRepeatables', () => {
  it('removes every entry when no match is given', async () => {
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

  it('matches on either the job id or the job name', async () => {
    const queue = makeQueue([
      repeatable({ key: 'by-id', id: 'alerts:scan', name: 'other' }),
      repeatable({ key: 'by-name', id: null, name: 'scan' }),
      repeatable({ key: 'unrelated', id: 'something-else', name: 'other' }),
    ]);

    await removeRepeatables(queue, {
      onError: 'skip',
      onSkipped: jest.fn(),
      match: (r) => r.id === 'alerts:scan' || r.name === 'scan',
    });

    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      'by-id',
      'by-name',
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
      const queue = makeQueue();
      queue.getRepeatableJobs.mockRejectedValue(new Error('listing failed'));
      await expect(removeRepeatables(queue, opts)).rejects.toThrow(
        'listing failed',
      );
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

describe('registerRepeatableCron', () => {
  const base = {
    jobId: 'domain-checks:scheduled',
    jobName: 'scheduled',
    data: { kind: 'scheduled' },
    label: 'domain-checks',
    disabledMessage: 'DOMAIN_CHECK_CRON=off — scheduled domain checks disabled.',
  };

  it('clears stale entries for this lane, then registers the current cron', async () => {
    const queue = makeQueue([
      repeatable({ key: 'stale', id: 'domain-checks:scheduled' }),
      repeatable({ key: 'other-lane', id: 'alerts:scan', name: 'scan' }),
    ]);
    const logger = makeLogger();

    await registerRepeatableCron({ ...base, queue, logger, cron: '17 3 * * *' });

    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      'stale',
    ]);
    expect(queue.add).toHaveBeenCalledWith(
      'scheduled',
      { kind: 'scheduled' },
      { repeat: { pattern: '17 3 * * *' }, jobId: 'domain-checks:scheduled' },
    );
    expect(logger.log).toHaveBeenCalledWith(
      'Registered scheduled domain-checks job with cron "17 3 * * *"',
    );
  });

  it('sweeps before it adds', async () => {
    const queue = makeQueue([repeatable({ key: 'stale', id: base.jobId })]);

    await registerRepeatableCron({
      ...base,
      queue,
      logger: makeLogger(),
      cron: '17 3 * * *',
    });

    // Schedulers and legacy repeatables share one Redis zset, so an add that
    // landed first would be swept away by its own registrar.
    expect(
      Math.max(...queue.removeRepeatableByKey.mock.invocationCallOrder),
    ).toBeLessThan(Math.min(...queue.add.mock.invocationCallOrder));
  });

  it("warns and registers nothing when the cron is 'off'", async () => {
    const queue = makeQueue([repeatable({ key: 'stale', id: base.jobId })]);
    const logger = makeLogger();

    await registerRepeatableCron({ ...base, queue, logger, cron: 'off' });

    // The sweep still runs, so toggling a lane off also clears its leftovers.
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale');
    expect(queue.add).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(base.disabledMessage);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('warns about a stuck key and still registers', async () => {
    const queue = makeQueue([repeatable({ key: 'stale', id: base.jobId })]);
    queue.removeRepeatableByKey.mockRejectedValueOnce(new Error('redis gone'));
    const logger = makeLogger();

    await registerRepeatableCron({ ...base, queue, logger, cron: '17 3 * * *' });

    expect(queue.add).toHaveBeenCalledTimes(1);
    // The leftover will double-fire until the next restart, so it must not be
    // discarded the way the pre-helper `.catch(() => undefined)` discarded it.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove a stale domain-checks repeatable'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('redis gone'),
    );
  });
});
