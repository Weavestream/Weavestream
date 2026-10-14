import { markdownExcerpt, markdownToPlaintext } from '@weavestream/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  MarkdownPlaintextRefreshService,
  refreshMarkdownPlaintext,
  type MarkdownRefreshRole,
} from './markdown-plaintext-refresh.service.js';

/** The SQL text and bound values of one tagged-template raw call. */
function sqlCall(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join('?').replace(/\s+/g, ' '), values };
}

describe('refreshMarkdownPlaintext', () => {
  type Row = { id: string; markdownSource: string; contentPlaintext: string; derivedExcerpt: string | null };

  /** `affected` is what each guarded UPDATE reports (0 = the row changed meanwhile). */
  function setup(rows: Row[], affected: number[] = rows.map(() => 1)) {
    const findMany = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    const executeRaw = jest.fn();
    for (const n of affected) executeRaw.mockResolvedValueOnce(n);
    const prisma = { article: { findMany }, $executeRaw: executeRaw } as unknown as PrismaService;
    return { prisma, findMany, executeRaw };
  }

  const md = 'Use `create_article` then:\n\n```\nGet-Service\n```';
  const current = { contentPlaintext: markdownToPlaintext(md), derivedExcerpt: markdownExcerpt(md) || null };

  it('rewrites only stale rows, guarded on the source it derived from, without touching updated_at', async () => {
    const { prisma, findMany, executeRaw } = setup([
      { id: 'a1', markdownSource: md, contentPlaintext: 'stale', derivedExcerpt: 'stale' },
      { id: 'a2', markdownSource: md, ...current },
    ]);

    await expect(refreshMarkdownPlaintext(prisma)).resolves.toBe(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { editorMode: 'markdown', markdownSource: { not: null } } }),
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = sqlCall(executeRaw.mock.calls[0]!);
    expect(sql).toContain('SET "content_plaintext" = ?, "derived_excerpt" = ?');
    expect(sql).toContain('"markdown_source" = ?');
    expect(sql).not.toContain('updated_at');
    expect(values).toEqual([current.contentPlaintext, current.derivedExcerpt, 'a1', md]);
  });

  it('does not count a row an edit changed after the batch was read', async () => {
    const { prisma } = setup(
      [{ id: 'a1', markdownSource: md, contentPlaintext: 'stale', derivedExcerpt: 'stale' }],
      [0],
    );
    await expect(refreshMarkdownPlaintext(prisma)).resolves.toBe(0);
  });
});

describe('MarkdownPlaintextRefreshService', () => {
  function setup(role: MarkdownRefreshRole, opts: { marker: boolean; findMany?: jest.Mock }) {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ present: opts.marker ? 'pending_markdown_plaintext_refresh' : null }]);
    const executeRaw = jest.fn().mockResolvedValue(0);
    const findMany = opts.findMany ?? jest.fn().mockResolvedValue([]);
    const prisma = { $queryRaw: queryRaw, $executeRaw: executeRaw, article: { findMany } } as unknown as PrismaService;
    return { svc: new MarkdownPlaintextRefreshService(prisma, role), executeRaw, findMany };
  }

  const drops = (executeRaw: jest.Mock) =>
    executeRaw.mock.calls.some((c) => sqlCall(c).sql.includes('DROP TABLE IF EXISTS "pending_markdown_plaintext_refresh"'));

  it.each<MarkdownRefreshRole>(['api', 'worker'])('%s does nothing on a normal boot (no marker)', async (role) => {
    const { svc, findMany, executeRaw } = setup(role, { marker: false });
    await svc.run();
    expect(findMany).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('api refreshes but keeps the marker: an old worker may still be writing', async () => {
    const { svc, findMany, executeRaw } = setup('api', { marker: true });
    await svc.run();
    expect(findMany).toHaveBeenCalled();
    expect(drops(executeRaw)).toBe(false);
  });

  it('worker refreshes, then drops the marker', async () => {
    const { svc, findMany, executeRaw } = setup('worker', { marker: true });
    await svc.run();
    expect(findMany).toHaveBeenCalled();
    expect(drops(executeRaw)).toBe(true);
  });

  it('worker keeps the marker when the refresh fails, so the next boot resumes', async () => {
    const { svc, executeRaw } = setup('worker', {
      marker: true,
      findMany: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(svc.run()).resolves.toBeUndefined();
    expect(drops(executeRaw)).toBe(false);
  });
});
