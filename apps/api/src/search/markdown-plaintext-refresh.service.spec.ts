import { markdownExcerpt, markdownToPlaintext } from '@weavestream/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { refreshMarkdownPlaintext } from './markdown-plaintext-refresh.service.js';

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
