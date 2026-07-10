import { LockoutService } from './lockout.service.js';

/**
 * Minimal in-memory Redis fake covering exactly what LockoutService touches:
 * `get`, `del`, and a `multi().incr().expire().exec()` chain. TTLs are not
 * modeled (expire is a no-op) — these tests assert counter semantics and key
 * shape, not expiry.
 */
function makeLockout(maxFailures = 5) {
  const store = new Map<string, string>();
  const client = {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async del(key: string): Promise<void> {
      store.delete(key);
    },
    multi() {
      const ops: Array<() => void> = [];
      const chain = {
        incr(key: string) {
          ops.push(() => {
            const cur = parseInt(store.get(key) ?? '0', 10);
            store.set(key, String(cur + 1));
          });
          return chain;
        },
        expire(_key: string, _sec: number) {
          return chain;
        },
        async exec() {
          for (const op of ops) op();
          return [];
        },
      };
      return chain;
    },
  };
  const env = {
    values: { LOCKOUT_MAX_FAILURES: maxFailures, LOCKOUT_WINDOW_MIN: 15 },
  };
  const svc = new LockoutService(env as never, { client } as never);
  return { svc, store };
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
