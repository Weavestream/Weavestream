import { __resetRunCacheForTests, evictRun, runCached } from './run-cache.js';
import type { IntegrationContext } from './integration-driver.js';

const SNAPSHOT = '2026-10-12T00:00:00.000Z';
const ctx = (connectionId?: string) =>
  ({ integrationId: 'int-1', connectionId, correlationId: 'c', config: {}, secret: {}, http: {} }) as unknown as IntegrationContext;

beforeEach(() => __resetRunCacheForTests());

describe('runCached', () => {
  it('shares one lookup across the pages of one run', async () => {
    const load = jest.fn(async () => 'v');
    await runCached(ctx('a'), SNAPSHOT, 'org', load);
    await runCached(ctx('a'), SNAPSHOT, 'org', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never hands one tenant connection the lookup of another under the same integration and snapshot', async () => {
    await expect(runCached(ctx('tenant-a'), SNAPSHOT, 'org', async () => 'org-a')).resolves.toBe('org-a');
    await expect(runCached(ctx('tenant-b'), SNAPSHOT, 'org', async () => 'org-b')).resolves.toBe('org-b');
  });

  it('evicts only the finished connection run', async () => {
    const loadA = jest.fn(async () => 'a');
    await runCached(ctx('tenant-a'), SNAPSHOT, 'org', loadA);
    await runCached(ctx('tenant-b'), SNAPSHOT, 'org', async () => 'b');
    evictRun(ctx('tenant-b'), SNAPSHOT);
    await runCached(ctx('tenant-a'), SNAPSHOT, 'org', loadA);
    expect(loadA).toHaveBeenCalledTimes(1);
  });
});
