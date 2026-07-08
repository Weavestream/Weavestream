import { PasswordService } from './password.service.js';

function makeService() {
  // Small (but argon2-valid) params so tests stay fast; production values come from env.
  const env = {
    values: { ARGON2_MEMORY_KB: 16384, ARGON2_ITERATIONS: 2, ARGON2_PARALLELISM: 1 },
  };
  return new PasswordService(env as never);
}

describe('PasswordService.dummyHash (WS-025)', () => {
  it('memoizes: repeated calls return the same promise and hash only once', async () => {
    const svc = makeService();
    const hashSpy = jest.spyOn(svc, 'hash');

    const first = svc.dummyHash();
    const second = svc.dummyHash();

    expect(second).toBe(first);
    await first;
    expect(hashSpy).toHaveBeenCalledTimes(1);
  });

  it('produces a hash that verifies only against its own random input (never a guess)', async () => {
    const svc = makeService();
    const dummy = await svc.dummyHash();

    await expect(svc.verify(dummy, 'any-attacker-guess')).resolves.toBe(false);
  });

  it('does not memoize a rejection: a failed computation is retried on the next call', async () => {
    const svc = makeService();
    const hashSpy = jest
      .spyOn(svc, 'hash')
      .mockRejectedValueOnce(new Error('argon2 unavailable'));

    await expect(svc.dummyHash()).rejects.toThrow('argon2 unavailable');

    // The rejected promise was reset; the next call re-runs hash and succeeds.
    const dummy = await svc.dummyHash();
    expect(dummy).toMatch(/^\$argon2id\$/);
    expect(hashSpy).toHaveBeenCalledTimes(2);
  });

  it('onModuleInit awaits the warmup so boot fails if hashing fails', async () => {
    const svc = makeService();
    jest.spyOn(svc, 'hash').mockRejectedValue(new Error('argon2 unavailable'));

    await expect(svc.onModuleInit()).rejects.toThrow('argon2 unavailable');
  });
});
