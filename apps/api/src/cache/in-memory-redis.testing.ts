/**
 * Test-only: the slice of ioredis that `MembershipCacheService` uses, backed
 * by a Map, so specs can drive real cache semantics (generation tokens, NX,
 * MULTI) and interleave loads with invalidations. TTLs are ignored.
 * Excluded from the build by tsconfig.build.json.
 */
export function inMemoryRedis() {
  const store = new Map<string, string>();
  const client = {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    mget: jest.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    set: jest.fn(async (k: string, v: string, ...opts: Array<string | number>) => {
      if (opts.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (...keys: string[]) => keys.filter((k) => store.delete(k)).length),
    multi: jest.fn(() => {
      const ops: Array<() => Promise<unknown>> = [];
      const tx = {
        set: (k: string, v: string, ...opts: Array<string | number>) => {
          ops.push(() => client.set(k, v, ...opts));
          return tx;
        },
        del: (...keys: string[]) => {
          ops.push(() => client.del(...keys));
          return tx;
        },
        exec: async () => {
          const out: Array<[Error | null, unknown]> = [];
          for (const op of ops) out.push([null, await op()]);
          return out;
        },
      };
      return tx;
    }),
  };
  return { client };
}
