import { pruneAssetVersions } from './asset-versions-retention.js';

function prisma(rows: Array<{ n: bigint | number }> = [{ n: 7 }], deleted = 4) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const flatten = (strings: readonly string[], values: unknown[]) => {
    let text = '';
    const out: unknown[] = [];
    strings.forEach((s, i) => {
      text += s;
      if (i >= values.length) return;
      const v = values[i] as { strings?: readonly string[]; values?: unknown[] };
      if (v && typeof v === 'object' && v.strings && v.values) {
        const inner = flatten(v.strings, v.values);
        text += inner.text;
        out.push(...inner.values);
      } else {
        text += '?';
        out.push(v);
      }
    });
    return { text: text.replace(/\s+/g, ' ').trim(), values: out };
  };
  return {
    calls,
    client: {
      $queryRaw: jest.fn(async (s: readonly string[], ...v: unknown[]) => {
        calls.push(flatten(s, v));
        return rows;
      }),
      $executeRaw: jest.fn(async (s: readonly string[], ...v: unknown[]) => {
        calls.push(flatten(s, v));
        return deleted;
      }),
    },
  };
}

const NOW = new Date('2026-11-25T00:00:00.000Z');

describe('pruneAssetVersions', () => {
  it('dry run counts but deletes nothing', async () => {
    const p = prisma([{ n: BigInt(7) }]);
    const out = await pruneAssetVersions(p.client as never, { olderThanDays: 30, dryRun: true, now: NOW });
    expect(out).toEqual({ cutoff: new Date('2026-10-26T00:00:00.000Z'), eligible: 7, deleted: 0 });
    expect(p.client.$executeRaw).not.toHaveBeenCalled();
    expect(p.calls[0]!.text).toMatch(/^SELECT count\(\*\)/);
  });

  it('apply deletes only rows older than the cutoff, never the first or latest of an asset', async () => {
    const p = prisma(undefined, 4);
    const out = await pruneAssetVersions(p.client as never, { olderThanDays: 30, dryRun: false, now: NOW });
    expect(out).toEqual({ cutoff: new Date('2026-10-26T00:00:00.000Z'), eligible: 4, deleted: 4 });
    const sql = p.calls[0]!;
    expect(sql.text).toMatch(/^DELETE FROM asset_versions v WHERE v\.created_at < \?/);
    expect(sql.text).toMatch(/v\.version > \(SELECT min\(m\.version\) FROM asset_versions m WHERE m\.asset_id = v\.asset_id\)/);
    expect(sql.text).toMatch(/v\.version < \(SELECT max\(m\.version\) FROM asset_versions m WHERE m\.asset_id = v\.asset_id\)/);
    expect(sql.values).toEqual([new Date('2026-10-26T00:00:00.000Z')]);
  });

  it.each([0, -1, 1.5, 3651, NaN])('rejects %s days', async (days) => {
    const p = prisma();
    await expect(
      pruneAssetVersions(p.client as never, { olderThanDays: days, dryRun: false, now: NOW }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(p.client.$executeRaw).not.toHaveBeenCalled();
  });
});
