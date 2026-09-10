import {
  registerRepeatableCron,
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

function makeQueue(entries: RepeatableJob[] = []) {
  const queue = {
    getRepeatableJobs: jest.fn().mockResolvedValue(entries),
    removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
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

    await removeRepeatables(queue, { onError: 'skip' });

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
      match: (r) => r.id === 'alerts:scan' || r.name === 'scan',
    });

    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      'by-id',
      'by-name',
    ]);
  });

  it("keeps going past a stuck key under 'skip'", async () => {
    const queue = makeQueue([repeatable({ key: 'a' }), repeatable({ key: 'b' })]);
    queue.removeRepeatableByKey.mockRejectedValueOnce(new Error('redis gone'));

    await expect(
      removeRepeatables(queue, { onError: 'skip' }),
    ).resolves.toBeUndefined();

    expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(2);
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
    for (const onError of ['skip', 'throw'] as const) {
      const queue = makeQueue();
      queue.getRepeatableJobs.mockRejectedValue(new Error('listing failed'));
      await expect(removeRepeatables(queue, { onError })).rejects.toThrow(
        'listing failed',
      );
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

  it('tolerates a stuck key and still registers', async () => {
    const queue = makeQueue([repeatable({ key: 'stale', id: base.jobId })]);
    queue.removeRepeatableByKey.mockRejectedValueOnce(new Error('redis gone'));

    await registerRepeatableCron({
      ...base,
      queue,
      logger: makeLogger(),
      cron: '17 3 * * *',
    });

    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
