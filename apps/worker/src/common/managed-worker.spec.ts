/**
 * The first spec in this app to mock `bullmq`. The fake Worker extends a real
 * `EventEmitter`, so `emit('failed', …)` genuinely runs the helper's listener
 * rather than only proving the listener was registered.
 *
 * `close()` and `waitUntilReady()` resolve immediately by default. A test that
 * needs to observe what has NOT yet happened calls `hold(...)` first, which
 * swaps in a pending promise and hands back its resolver.
 */
jest.mock('bullmq', () => {
  // jest.mock factories hoist above the imports, so nothing here may close
  // over module scope. Require inside.
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class Holdable extends EventEmitter {
    closeResult: Promise<void> = Promise.resolve();
    close = jest.fn(() => this.closeResult);

    hold(field: 'closeResult' | 'readyResult'): {
      resolve: () => void;
      reject: (e: unknown) => void;
    } {
      let release!: { resolve: () => void; reject: (e: unknown) => void };
      (this as any)[field] = new Promise<void>((res, rej) => {
        release = { resolve: () => res(), reject: rej };
      });
      return release;
    }
  }

  class FakeWorker extends Holdable {
    static instances: FakeWorker[] = [];
    readyResult: Promise<void> = Promise.resolve();
    waitUntilReady = jest.fn(() => this.readyResult);

    constructor(
      readonly queueName: string,
      readonly handler: unknown,
      readonly opts: Record<string, unknown>,
    ) {
      super();
      FakeWorker.instances.push(this);
    }
  }

  class FakeQueue extends Holdable {
    static instances: FakeQueue[] = [];
    constructor() {
      super();
      FakeQueue.instances.push(this);
    }
  }

  return { __esModule: true, Worker: FakeWorker, Queue: FakeQueue };
});

import { Queue, Worker } from 'bullmq';
import { createManagedWorker, type ManagedWorker } from './managed-worker.js';

interface Fake {
  queueName: string;
  handler: unknown;
  opts: Record<string, unknown>;
  close: jest.Mock;
  waitUntilReady: jest.Mock;
  emit(event: string, ...args: unknown[]): boolean;
  hold(field: 'closeResult' | 'readyResult'): {
    resolve: () => void;
    reject: (e: unknown) => void;
  };
}

const FakeWorker = Worker as unknown as { instances: Fake[] };
const FakeQueue = Queue as unknown as { instances: Fake[] };

const makeLogger = () => ({
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const newProducer = () => new (Queue as unknown as new () => unknown)() as Fake;

/** Lets already-queued microtasks drain so we can inspect a pending close. */
const tick = () => new Promise((r) => setImmediate(r));

const lastWorker = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;

function build(
  overrides: Partial<Parameters<typeof createManagedWorker>[0]> = {},
): { managed: ManagedWorker; logger: ReturnType<typeof makeLogger>; worker: Fake } {
  const logger = makeLogger();
  const managed = createManagedWorker({
    queue: 'test-queue',
    logger,
    handler: async () => undefined,
    options: { connection: {} as never, concurrency: 2 },
    ...overrides,
  });
  return { managed, logger, worker: lastWorker() };
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  FakeQueue.instances.length = 0;
});

describe('createManagedWorker — construction', () => {
  it('passes the queue name, handler and every option through verbatim', () => {
    const handler = async () => undefined;
    const connection = {} as never;
    const { worker } = build({
      queue: 'backup',
      handler,
      options: {
        connection,
        concurrency: 1,
        lockDuration: 21_600_000,
        lockRenewTime: 3_600_000,
        stalledInterval: 60_000,
      },
    });

    expect(worker.queueName).toBe('backup');
    expect(worker.handler).toBe(handler);
    // The lock knobs are the axis a `concurrency: number` helper would eat.
    expect(worker.opts).toEqual({
      connection,
      concurrency: 1,
      lockDuration: 21_600_000,
      lockRenewTime: 3_600_000,
      stalledInterval: 60_000,
    });
  });

  it('returns synchronously without awaiting readiness', () => {
    const { managed, worker } = build();
    expect(managed.worker).toBeDefined();
    // The whole reason this helper is not async: main.ts enables shutdown
    // hooks before starting consumers, so the caller must own the handle
    // before the readiness window opens.
    expect(worker.waitUntilReady).not.toHaveBeenCalled();
  });
});

describe('createManagedWorker — readiness', () => {
  it('awaits readiness, then logs once with concurrency and detail', async () => {
    const { managed, logger, worker } = build({
      queue: 'backup',
      options: { connection: {} as never, concurrency: 3 },
      readyDetail: 'dir=/var/lib/weavestream/backup, lock=360min',
    });

    await managed.ready();

    expect(worker.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      '[backup] worker ready (concurrency=3, dir=/var/lib/weavestream/backup, lock=360min)',
    );
  });

  it('defaults concurrency to 1 in the ready line and uses queue as label', async () => {
    const { managed, logger } = build({
      queue: 'alerts',
      options: { connection: {} as never },
    });
    await managed.ready();
    expect(logger.log).toHaveBeenCalledWith('[alerts] worker ready (concurrency=1)');
  });

  it('stays silent on the first ready event and logs later reconnects', async () => {
    const { managed, logger, worker } = build({ queue: 'alerts' });

    worker.emit('ready');
    expect(logger.log).not.toHaveBeenCalled();

    await managed.ready();
    logger.log.mockClear();

    worker.emit('ready');
    expect(logger.log).toHaveBeenCalledWith('[alerts] worker reconnected to Redis');
  });
});

describe('createManagedWorker — failure logging', () => {
  it('renders a missing job id as <unknown>', () => {
    const { logger, worker } = build({ queue: 'alerts' });
    worker.emit('failed', undefined, new Error('boom'));
    expect(logger.error).toHaveBeenCalledWith('[alerts] job <unknown> failed: boom');
  });

  it('renders a non-Error rejection instead of swallowing it', () => {
    const { logger, worker } = build({ queue: 'alerts' });
    worker.emit('failed', { id: '7' }, 'boom-string');
    expect(logger.error).toHaveBeenCalledWith('[alerts] job 7 failed: boom-string');
  });

  it('falls back to the error name when the message is empty', () => {
    const { logger, worker } = build({ queue: 'alerts' });
    worker.emit('failed', { id: '7' }, new Error(''));
    expect(logger.error).toHaveBeenCalledWith('[alerts] job 7 failed: Error');
  });

  it('appends describeFailure inside the line and passes job and error to onFailed', () => {
    const onFailed = jest.fn();
    const err = new Error('boom');
    const { logger, worker } = build({
      queue: 'article-summary',
      describeFailure: (e) => ` — ${(e as Error).name}`,
      onFailed,
    });

    worker.emit('failed', { id: '7' }, err);

    expect(logger.error).toHaveBeenCalledWith(
      '[article-summary] job 7 failed: boom — Error',
    );
    expect(onFailed).toHaveBeenCalledWith({ id: '7' }, err);
  });

  it('keeps a throwing onFailed in the structured log', () => {
    const { logger, worker } = build({
      queue: 'alerts',
      onFailed: () => {
        throw new Error('hook exploded');
      },
    });

    // BullMQ's QueueBase.emit would catch this and fall back to console.error,
    // which bypasses the Nest logger.
    expect(() => worker.emit('failed', { id: '7' }, new Error('boom'))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      '[alerts] failed-hook threw: hook exploded',
    );
  });

  it('still logs the failure when describeFailure throws', () => {
    const { logger, worker } = build({
      queue: 'alerts',
      describeFailure: () => {
        throw new Error('bad describe');
      },
    });
    worker.emit('failed', { id: '7' }, new Error('boom'));
    expect(logger.error).toHaveBeenCalledWith('[alerts] job 7 failed: boom');
  });
});

describe('createManagedWorker — opt-in listeners', () => {
  it('ignores completed and stalled by default', () => {
    const { logger, worker } = build({ queue: 'alerts' });
    worker.emit('completed', { id: '7' });
    worker.emit('stalled', '7');
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs completed and warns on stalled when enabled', () => {
    const { logger, worker } = build({
      queue: 'backup',
      logCompleted: true,
      logStalled: true,
    });
    worker.emit('completed', { id: '7' });
    worker.emit('stalled', '7');
    expect(logger.log).toHaveBeenCalledWith('[backup] job 7 completed');
    expect(logger.warn).toHaveBeenCalledWith(
      '[backup] job 7 stalled; waiting for recovery',
    );
  });
});

describe('createManagedWorker — shutdown', () => {
  it('closes the worker even when readiness is still pending', async () => {
    const { managed, worker } = build();
    const release = worker.hold('readyResult');

    const readying = managed.ready();
    await managed.close();

    // The startup-window regression the synchronous constructor exists to
    // prevent: a SIGTERM during boot must still drain this worker.
    expect(worker.close).toHaveBeenCalledTimes(1);
    release.resolve();
    await readying;
  });

  it('waits for the worker drain to COMPLETE before closing any producer', async () => {
    const first = newProducer();
    const second = newProducer();
    const { managed, worker } = build({ producers: [first, second] });

    const release = worker.hold('closeResult');
    const closing = managed.close();
    await tick();

    // A Promise.all implementation would satisfy an invocation-order
    // assertion and still break a draining job's cleanup enqueue.
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();

    release.resolve();
    await closing;

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('closes the producers and resolves when the worker close rejects', async () => {
    const producer = newProducer();
    const { managed, logger, worker } = build({
      queue: 'company-export',
      producers: [producer],
    });
    worker.hold('closeResult').reject(new Error('redis gone'));

    await expect(managed.close()).resolves.toBeUndefined();

    expect(producer.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[company-export] worker close failed: redis gone',
    );
  });

  it('closes the second producer when the first one rejects', async () => {
    const first = newProducer();
    const second = newProducer();
    const { managed, logger } = build({
      queue: 'backup',
      producers: [first, second],
    });
    first.hold('closeResult').reject(new Error('producer gone'));

    await expect(managed.close()).resolves.toBeUndefined();

    expect(second.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[backup] producer close failed: producer gone',
    );
  });

  it('is idempotent across repeated calls', async () => {
    const { managed, worker } = build();
    await managed.close();
    await managed.close();
    expect(worker.close).toHaveBeenCalledTimes(1);
  });
});
