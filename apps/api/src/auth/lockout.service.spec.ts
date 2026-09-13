import { LockoutService } from './lockout.service.js';

/**
 * Minimal in-memory Redis fake covering exactly what LockoutService touches:
 * `get`, `del`, and a `multi().incr().expire().exec()` chain. TTLs are not
 * modeled (expire is a no-op returning 1) — these tests assert counter
 * semantics, key shape, and the ioredis-shaped `[error, reply][]` exec
 * result the count-returning record* methods parse.
 */
function makeLockout(maxFailures = 5) {
  const store = new Map<string, string>();
  const client = {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    del: jest.fn(async (key: string): Promise<void> => {
      store.delete(key);
    }),
    multi() {
      const ops: Array<() => number> = [];
      const chain = {
        incr(key: string) {
          ops.push(() => {
            const next = parseInt(store.get(key) ?? '0', 10) + 1;
            store.set(key, String(next));
            return next;
          });
          return chain;
        },
        expire(_key: string, _sec: number) {
          ops.push(() => 1);
          return chain;
        },
        async exec(): Promise<[Error | null, unknown][]> {
          return ops.map((op) => [null, op()]);
        },
      };
      return chain;
    },
  };
  const env = {
    values: { LOCKOUT_MAX_FAILURES: maxFailures, LOCKOUT_WINDOW_MIN: 15 },
  };
  const svc = new LockoutService(env as never, { client } as never);
  return { svc, store, client };
}

describe('LockoutService MFA counter', () => {
  it('locks a user at the threshold and leaves other users unaffected', async () => {
    const { svc } = makeLockout(5);

    for (let i = 0; i < 4; i++) await svc.recordMfaFailure('u-A');
    expect(await svc.isMfaLocked('u-A')).toBe(false); // 4 < 5

    await svc.recordMfaFailure('u-A');
    expect(await svc.isMfaLocked('u-A')).toBe(true); // 5 >= 5

    // The whole point of the fix: one user's failures don't lock anyone else.
    expect(await svc.isMfaLocked('u-B')).toBe(false);
  });

  it('clearMfaFailures resets the user counter', async () => {
    const { svc } = makeLockout(5);

    for (let i = 0; i < 5; i++) await svc.recordMfaFailure('u-A');
    expect(await svc.isMfaLocked('u-A')).toBe(true);

    await svc.clearMfaFailures('u-A');
    expect(await svc.isMfaLocked('u-A')).toBe(false);
  });

  it('writes only the per-user mfa:fail key, never the login buckets', async () => {
    const { svc, store } = makeLockout(5);

    await svc.recordMfaFailure('u-1');

    expect(store.has('mfa:fail:u-1')).toBe(true);
    const keys = [...store.keys()];
    expect(keys.some((k) => k.startsWith('login:fail:email:'))).toBe(false);
    expect(keys.some((k) => k.startsWith('login:fail:ip:'))).toBe(false);
  });
});

describe('LockoutService failure-count returns (security alerts)', () => {
  it('recordFailure returns both post-increment counts from the MULTI replies', async () => {
    const { svc } = makeLockout(5);

    await expect(svc.recordFailure('9.9.9.9', 'a@example.com')).resolves.toEqual({
      ip: 1,
      email: 1,
    });
    await expect(svc.recordFailure('9.9.9.9', 'a@example.com')).resolves.toEqual({
      ip: 2,
      email: 2,
    });
    // Distinct email from the same IP: ip counter keeps climbing, the
    // fresh email bucket starts at 1 — the alert emitter relies on this
    // to detect which counter crossed the threshold.
    await expect(svc.recordFailure('9.9.9.9', 'b@example.com')).resolves.toEqual({
      ip: 3,
      email: 1,
    });
  });

  it('single-counter record methods return the post-increment count', async () => {
    const { svc } = makeLockout(5);
    await expect(svc.recordMfaFailure('u-A')).resolves.toBe(1);
    await expect(svc.recordMfaFailure('u-A')).resolves.toBe(2);
    await expect(svc.recordChangePasswordFailure('u-A')).resolves.toBe(1);
  });

  function withExecResult(
    client: { multi: unknown },
    exec: () => Promise<[Error | null, unknown][] | null>,
  ): void {
    (client as { multi: () => unknown }).multi = () => {
      const chain = {
        incr: () => chain,
        expire: () => chain,
        exec,
      };
      return chain;
    };
  }

  it('fails closed when the MULTI rejects (Redis down mid-request)', async () => {
    const { svc, client } = makeLockout(5);
    withExecResult(client, async () => {
      throw new Error('connection refused');
    });
    await expect(svc.recordFailure('9.9.9.9', 'a@example.com')).rejects.toThrow(
      'connection refused',
    );
    await expect(svc.recordMfaFailure('u-A')).rejects.toThrow('connection refused');
  });

  it('fails closed when exec resolves null (aborted transaction)', async () => {
    const { svc, client } = makeLockout(5);
    withExecResult(client, async () => null);
    await expect(svc.recordFailure('9.9.9.9', 'a@example.com')).rejects.toThrow(
      /transaction aborted/,
    );
  });

  it('fails closed and self-heals the key whose INCR reply errored', async () => {
    const { svc, client } = makeLockout(5);
    // ip INCR errored (e.g. non-integer garbage in the key); email pair OK.
    withExecResult(client, async () => [
      [new Error('value is not an integer'), null],
      [null, 1],
      [null, 3],
      [null, 1],
    ]);
    await expect(svc.recordFailure('9.9.9.9', 'a@example.com')).rejects.toThrow(
      /INCR failed/,
    );
    expect(client.del).toHaveBeenCalledWith('login:fail:ip:9.9.9.9');
    expect(client.del).not.toHaveBeenCalledWith('login:fail:email:a@example.com');
  });

  it('fails closed and deletes the key when EXPIRE errored (would be a TTL-less counter)', async () => {
    const { svc, client } = makeLockout(5);
    // ip INCR fine, ip EXPIRE errored — without a TTL the counter would
    // accumulate forever and permanently lock the subject once past the
    // threshold (the 429 branch runs before the clearing path).
    withExecResult(client, async () => [
      [null, 5],
      [new Error('EXPIRE not permitted'), null],
      [null, 3],
      [null, 1],
    ]);
    await expect(svc.recordFailure('9.9.9.9', 'a@example.com')).rejects.toThrow(
      /EXPIRE failed/,
    );
    expect(client.del).toHaveBeenCalledWith('login:fail:ip:9.9.9.9');
    expect(client.del).not.toHaveBeenCalledWith('login:fail:email:a@example.com');
  });

  it('fails closed when EXPIRE returns an unexpected reply (single counter)', async () => {
    const { svc, client } = makeLockout(5);
    withExecResult(client, async () => [
      [null, 2],
      [null, 0], // EXPIRE reporting "key does not exist"
    ]);
    await expect(svc.recordMfaFailure('u-A')).rejects.toThrow(/EXPIRE failed/);
    expect(client.del).toHaveBeenCalledWith('mfa:fail:u-A');
  });
});

describe('LockoutService change-password counter', () => {
  it('locks a user at the threshold and leaves other users unaffected', async () => {
    const { svc } = makeLockout(5);

    for (let i = 0; i < 4; i++) await svc.recordChangePasswordFailure('u-A');
    expect(await svc.isChangePasswordLocked('u-A')).toBe(false); // 4 < 5

    await svc.recordChangePasswordFailure('u-A');
    expect(await svc.isChangePasswordLocked('u-A')).toBe(true); // 5 >= 5

    expect(await svc.isChangePasswordLocked('u-B')).toBe(false);
  });

  it('clearChangePasswordFailures resets the user counter', async () => {
    const { svc } = makeLockout(5);

    for (let i = 0; i < 5; i++) await svc.recordChangePasswordFailure('u-A');
    expect(await svc.isChangePasswordLocked('u-A')).toBe(true);

    await svc.clearChangePasswordFailures('u-A');
    expect(await svc.isChangePasswordLocked('u-A')).toBe(false);
  });

  it('writes only the per-user changepw:fail key, never the login buckets', async () => {
    const { svc, store } = makeLockout(5);

    await svc.recordChangePasswordFailure('u-1');

    expect(store.has('changepw:fail:u-1')).toBe(true);
    const keys = [...store.keys()];
    expect(keys.some((k) => k.startsWith('login:fail:email:'))).toBe(false);
    expect(keys.some((k) => k.startsWith('login:fail:ip:'))).toBe(false);
  });
});

describe('LockoutService per-IP login counter keys', () => {
  it('keys an IPv4 client by its exact address', async () => {
    const { svc, store } = makeLockout(5);
    await svc.recordFailure('192.0.2.10', 'a@example.com');
    await svc.recordFailure('192.0.2.11', 'b@example.com');
    expect(store.get('login:fail:ip:192.0.2.10')).toBe('1');
    expect(store.get('login:fail:ip:192.0.2.11')).toBe('1');
  });

  it('keys an IPv4-mapped client by its IPv4 address', async () => {
    const { svc, store } = makeLockout(5);
    await svc.recordFailure('::ffff:192.0.2.10', 'a@example.com');
    expect(store.get('login:fail:ip:192.0.2.10')).toBe('1');
  });

  it('groups an IPv6 client by /64, so rotating addresses still locks it out', async () => {
    const { svc, store } = makeLockout(5);
    // Five failures from five addresses in one /64, each with a different
    // email, so only the IP counter can reach the threshold.
    for (let i = 1; i <= 5; i++) {
      await svc.recordFailure(`2001:db8:1:2::${i}`, `user${i}@example.com`);
    }
    expect(store.get('login:fail:ip:2001:db8:1:2::/64')).toBe('5');
    expect(await svc.isLocked('2001:DB8:1:2:ffff::1', 'other@example.com')).toBe(true);
    // The neighbouring /64 is a different client.
    expect(await svc.isLocked('2001:db8:1:3::1', 'other@example.com')).toBe(false);
  });

  it('clears the /64 counter from any address inside it', async () => {
    const { svc, store } = makeLockout(5);
    await svc.recordFailure('2001:db8:1:2::1', 'a@example.com');
    await svc.clear('2001:db8:1:2::99', 'a@example.com');
    expect(store.has('login:fail:ip:2001:db8:1:2::/64')).toBe(false);
  });
});
