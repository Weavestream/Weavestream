import type { PrismaService } from '../prisma/prisma.service.js';
import type { SearchIndexService } from './search-index.service.js';
import { SearchRefreshService, type SearchRefreshRole } from './search-refresh.service.js';

const MARKDOWN = 'pending_markdown_plaintext_refresh';
const ASSETS = 'pending_asset_search_reindex';

/** The SQL text of one raw call (tagged template or `Prisma.Sql`). */
function sqlText(call: unknown[]): string {
  const first = call[0] as TemplateStringsArray | { sql: string };
  const text = 'sql' in first ? first.sql : first.join('?');
  return text.replace(/\s+/g, ' ');
}

describe('SearchRefreshService', () => {
  function setup(
    role: SearchRefreshRole,
    opts: { markers: string[]; findMany?: jest.Mock; reindexAssets?: jest.Mock },
  ) {
    // The probe binds the marker name, so answer per bound value.
    const queryRaw = jest.fn((_strings: TemplateStringsArray, marker: string) =>
      Promise.resolve([{ present: opts.markers.includes(marker) ? marker : null }]),
    );
    const executeRaw = jest.fn().mockResolvedValue(0);
    const findMany = opts.findMany ?? jest.fn().mockResolvedValue([]);
    const reindexAssets = opts.reindexAssets ?? jest.fn().mockResolvedValue(3);
    const prisma = { $queryRaw: queryRaw, $executeRaw: executeRaw, article: { findMany } } as unknown as PrismaService;
    const searchIndex = { reindexAssets } as unknown as SearchIndexService;
    return { svc: new SearchRefreshService(prisma, searchIndex, role), executeRaw, findMany, reindexAssets };
  }

  const drops = (executeRaw: jest.Mock, marker: string) =>
    executeRaw.mock.calls.some((c) => sqlText(c).includes(`DROP TABLE IF EXISTS "${marker}"`));

  it.each<SearchRefreshRole>(['api', 'worker'])('%s does nothing on a normal boot (no marker)', async (role) => {
    const { svc, findMany, reindexAssets, executeRaw } = setup(role, { markers: [] });
    await svc.run();
    expect(findMany).not.toHaveBeenCalled();
    expect(reindexAssets).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('api runs both queued refreshes but keeps the markers: an old worker may still be writing', async () => {
    const { svc, findMany, reindexAssets, executeRaw } = setup('api', { markers: [MARKDOWN, ASSETS] });
    await svc.run();
    expect(findMany).toHaveBeenCalled();
    expect(reindexAssets).toHaveBeenCalled();
    expect(drops(executeRaw, MARKDOWN)).toBe(false);
    expect(drops(executeRaw, ASSETS)).toBe(false);
  });

  it('worker runs each queued refresh, then drops its marker', async () => {
    const { svc, findMany, reindexAssets, executeRaw } = setup('worker', { markers: [MARKDOWN, ASSETS] });
    await svc.run();
    expect(findMany).toHaveBeenCalled();
    expect(reindexAssets).toHaveBeenCalled();
    expect(drops(executeRaw, MARKDOWN)).toBe(true);
    expect(drops(executeRaw, ASSETS)).toBe(true);
  });

  it('runs only the job whose marker exists', async () => {
    const { svc, findMany, reindexAssets, executeRaw } = setup('worker', { markers: [ASSETS] });
    await svc.run();
    expect(findMany).not.toHaveBeenCalled();
    expect(reindexAssets).toHaveBeenCalled();
    expect(drops(executeRaw, MARKDOWN)).toBe(false);
    expect(drops(executeRaw, ASSETS)).toBe(true);
  });

  it('worker keeps a marker when its refresh fails, and still runs the other job', async () => {
    const { svc, reindexAssets, executeRaw } = setup('worker', {
      markers: [MARKDOWN, ASSETS],
      findMany: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(svc.run()).resolves.toBeUndefined();
    expect(drops(executeRaw, MARKDOWN)).toBe(false);
    expect(reindexAssets).toHaveBeenCalled();
    expect(drops(executeRaw, ASSETS)).toBe(true);
  });

  it('worker keeps the asset marker when the asset reindex fails, so the next boot resumes', async () => {
    const { svc, executeRaw } = setup('worker', {
      markers: [ASSETS],
      reindexAssets: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(svc.run()).resolves.toBeUndefined();
    expect(drops(executeRaw, ASSETS)).toBe(false);
  });
});
