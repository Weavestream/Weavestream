import { Semaphore } from './semaphore.js';

/** A promise whose resolve/reject we control from the test body. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let all currently-settled promise continuations run. */
const flush = () => new Promise<void>((res) => setImmediate(res));

describe('Semaphore', () => {
  it('runs tasks immediately while under capacity', async () => {
    const sem = new Semaphore(2);
    const started: number[] = [];
    const gates = [deferred(), deferred()];
    const runs = gates.map((gate, i) =>
      sem.run(async () => {
        started.push(i);
        await gate.promise;
      }),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
  });

  it('queues tasks beyond capacity and never exceeds it', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: 5 }, () => deferred());
    const runs = gates.map((gate) =>
      sem.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
      }),
    );
    // Release one at a time; the semaphore should backfill without ever
    // letting more than `capacity` bodies run at once.
    for (const gate of gates) {
      await flush();
      gate.resolve();
    }
    await Promise.all(runs);
    expect(maxActive).toBe(2);
  });

  it('wakes waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const completed: number[] = [];
    const gates = Array.from({ length: 4 }, () => deferred());
    const runs = gates.map((gate, i) =>
      sem.run(async () => {
        await gate.promise;
        completed.push(i);
      }),
    );
    for (const gate of gates) {
      await flush();
      gate.resolve();
    }
    await Promise.all(runs);
    expect(completed).toEqual([0, 1, 2, 3]);
  });

  it('releases the slot when a task rejects', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The failed task must not strand the capacity.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});
