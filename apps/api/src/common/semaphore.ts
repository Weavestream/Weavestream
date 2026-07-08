/**
 * Minimal FIFO async semaphore: at most `capacity` tasks passed to `run()`
 * execute concurrently; the rest queue in arrival order.
 *
 * Only `run()` is public so acquire/release is baked into one try/finally —
 * callers cannot leak a slot, even when their task throws. On release the
 * slot is handed directly to the queue head, so `inUse` never dips below
 * the true number of running tasks.
 *
 * Hand-rolled (WS-027) per the project rule against adding a dependency
 * for a one-liner.
 */
export class Semaphore {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.inUse -= 1;
  }
}
