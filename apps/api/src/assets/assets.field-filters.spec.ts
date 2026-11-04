import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AssetsService, MAX_ASSET_SEARCH_TERMS } from './assets.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Unit tests for the `field.<slug>=<value>` filter rules on the asset
 * list (discussion #99). The SQL itself is proven against Postgres in
 * `assets.field-filters.db.spec.ts`; this file covers field resolution,
 * error choice, and what is bound into the query.
 */

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OPERATOR = { id: 'u-1', role: 'OPERATOR' } as unknown as AuthedUser;

type FieldRow = {
  id: string;
  slug: string;
  fieldType: string;
  assetLayoutId: string;
  options: unknown;
  archivedAt: null;
};

function field(id: string, slug: string, fieldType: string, options: unknown = {}): FieldRow {
  return { id, slug, fieldType, assetLayoutId: `layout-of-${id}`, options, archivedAt: null };
}

function makeService(fields: FieldRow[], matchedIds: string[] = []) {
  const prisma = {
    assetField: { findMany: jest.fn(async () => fields) },
    $queryRaw: jest.fn(async () => matchedIds.map((asset_id) => ({ asset_id }))),
    asset: { findMany: jest.fn(async () => []) },
  };
  const service = new AssetsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

function sqlOf(prisma: ReturnType<typeof makeService>['prisma'], call = 0): Prisma.Sql {
  return (prisma.$queryRaw.mock.calls[call] as unknown as [Prisma.Sql])[0];
}

async function badRequestBody(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a BadRequestException');
}

describe('AssetsService.list field filters', () => {
  it('does not look up fields when there are no field filters', async () => {
    const { service, prisma } = makeService([]);
    await service.list(OPERATOR, COMPANY, {});
    expect(prisma.assetField.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('matches a slug on every layout when no layout is selected', async () => {
    const { service, prisma } = makeService(
      [field('f-laptop', 'manufacturer', 'TEXT'), field('f-server', 'manufacturer', 'TEXT')],
      ['a-1', 'a-2'],
    );

    await service.list(OPERATOR, COMPANY, { fieldFilters: { manufacturer: ' Dell ' } });

    const sql = sqlOf(prisma);
    expect(sql.values).toEqual(
      expect.arrayContaining([COMPANY, 'f-laptop', 'f-server', ['dell']]),
    );
    expect(sql.text).toContain(' OR ');
    const where = (prisma.asset.findMany.mock.calls[0] as unknown as [{ where: Prisma.AssetWhereInput }])[0]
      .where;
    expect(where.companyId).toBe(COMPANY);
    expect(where.AND).toEqual([{ id: { in: ['a-1', 'a-2'] } }]);
  });

  it('scopes the field lookup to the selected layout', async () => {
    const { service, prisma } = makeService([field('f-laptop', 'manufacturer', 'TEXT')]);
    await service.list(OPERATOR, COMPANY, {
      layoutId: 'layout-1',
      fieldFilters: { manufacturer: 'dell' },
    });
    expect(prisma.assetField.findMany).toHaveBeenCalledWith({
      where: { assetLayoutId: 'layout-1', slug: { in: ['manufacturer'] }, archivedAt: null },
    });
  });

  it('resolves a dropdown label to its stored slug', async () => {
    const { service, prisma } = makeService([
      field('f-vendor', 'vendor', 'DROPDOWN', {
        choices: [{ slug: 'dell', label: 'Dell Technologies' }],
      }),
    ]);
    await service.list(OPERATOR, COMPANY, { fieldFilters: { vendor: 'dell technologies' } });
    expect(sqlOf(prisma).values).toEqual(
      expect.arrayContaining([['dell technologies', 'dell']]),
    );
  });

  it('matches every dropdown choice that shares a label', async () => {
    const { service, prisma } = makeService([
      field('f-site', 'site', 'DROPDOWN', {
        choices: [
          { slug: 'a', label: 'Same' },
          { slug: 'b', label: 'Same' },
          { slug: 'c', label: 'Other' },
        ],
      }),
    ]);
    await service.list(OPERATOR, COMPANY, { fieldFilters: { site: 'same' } });
    expect(sqlOf(prisma).values).toEqual(expect.arrayContaining([['same', 'a', 'b']]));
  });

  it('skips a field whose type cannot take the value when another field can', async () => {
    const { service, prisma } = makeService([
      field('f-num', 'ram', 'NUMBER'),
      field('f-text', 'ram', 'TEXT'),
    ]);
    await service.list(OPERATOR, COMPANY, { fieldFilters: { ram: 'sixteen' } });
    const values = sqlOf(prisma).values;
    expect(values).toContain('f-text');
    expect(values).not.toContain('f-num');
  });

  it('binds NUMBER and BOOLEAN values as JSON', async () => {
    const { service, prisma } = makeService([
      field('f-ram', 'ram', 'NUMBER'),
      field('f-managed', 'managed', 'BOOLEAN'),
    ]);
    await service.list(OPERATOR, COMPANY, { fieldFilters: { ram: '16', managed: 'true' } });
    expect(sqlOf(prisma, 0).values).toContain('16');
    expect(sqlOf(prisma, 1).values).toContain('true');
    const where = (prisma.asset.findMany.mock.calls[0] as unknown as [{ where: Prisma.AssetWhereInput }])[0]
      .where;
    expect(where.AND).toHaveLength(2);
  });

  it('rejects an unknown slug, naming the scope it searched', async () => {
    const anyLayout = makeService([]);
    expect(
      await badRequestBody(
        anyLayout.service.list(OPERATOR, COMPANY, { fieldFilters: { nope: 'x' } }),
      ),
    ).toMatchObject({ error: 'UnknownFilterField', message: 'No field "nope" exists on any layout.' });

    const oneLayout = makeService([]);
    expect(
      await badRequestBody(
        oneLayout.service.list(OPERATOR, COMPANY, { layoutId: 'l-1', fieldFilters: { nope: 'x' } }),
      ),
    ).toMatchObject({ message: 'No field "nope" exists on the selected layout.' });
  });

  it('rejects a slug whose fields are all unfilterable', async () => {
    const { service, prisma } = makeService([field('f-tags', 'labels', 'TAGS')]);
    expect(
      await badRequestBody(service.list(OPERATOR, COMPANY, { fieldFilters: { labels: 'x' } })),
    ).toMatchObject({ error: 'UnfilterableField', fieldType: 'TAGS' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects a value that no field with the slug can take', async () => {
    const { service } = makeService([field('f-ram', 'ram', 'NUMBER')]);
    for (const raw of ['abc', '', 'Infinity']) {
      expect(
        await badRequestBody(service.list(OPERATOR, COMPANY, { fieldFilters: { ram: raw } })),
      ).toMatchObject({ error: 'InvalidFilterValue' });
    }
  });
});

describe('AssetsService.list stacked search terms', () => {
  function makeSearchService() {
    const prisma = {
      assetField: { findMany: jest.fn(async () => []) },
      asset: { findMany: jest.fn(async () => []) },
    };
    const searchIndex = {
      matchAssetIds: jest.fn(async (_companyId: string, term: string) => [`hit-${term}`]),
    };
    const service = new AssetsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      searchIndex as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const where = () =>
      (prisma.asset.findMany.mock.calls[0] as unknown as [{ where: Prisma.AssetWhereInput }])[0]
        .where;
    return { service, searchIndex, where };
  }

  it('requires every term to match, each by name or by the search index', async () => {
    const { service, searchIndex, where } = makeSearchService();

    await service.list(OPERATOR, COMPANY, { q: ['dell', ' 10.2.4 '] });

    expect(searchIndex.matchAssetIds).toHaveBeenCalledTimes(2);
    expect(where().companyId).toBe(COMPANY);
    expect(where().AND).toEqual([
      {
        OR: [
          { name: { contains: 'dell', mode: 'insensitive' } },
          { id: { in: ['hit-dell'] } },
        ],
      },
      {
        OR: [
          { name: { contains: '10.2.4', mode: 'insensitive' } },
          { id: { in: ['hit-10.2.4'] } },
        ],
      },
    ]);
  });

  it('keeps accepting a single term, and skips blank and repeated terms', async () => {
    const single = makeSearchService();
    await single.service.list(OPERATOR, COMPANY, { q: 'dell' });
    expect(single.where().AND).toHaveLength(1);

    const repeated = makeSearchService();
    await repeated.service.list(OPERATOR, COMPANY, { q: ['dell', 'DELL', '  '] });
    expect(repeated.searchIndex.matchAssetIds).toHaveBeenCalledTimes(1);
    expect(repeated.where().AND).toHaveLength(1);
  });

  it('checks every term before it runs any search', async () => {
    const { service, searchIndex } = makeSearchService();

    expect(
      await badRequestBody(
        service.list(OPERATOR, COMPANY, { q: ['dell', 'a b c d e f g h i'] }),
      ),
    ).toMatchObject({ error: 'SearchTermTooLong' });
    expect(searchIndex.matchAssetIds).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_ASSET_SEARCH_TERMS} terms before searching`, async () => {
    const { service, searchIndex } = makeSearchService();
    const terms = Array.from({ length: MAX_ASSET_SEARCH_TERMS + 1 }, (_, i) => `t${i}`);

    expect(await badRequestBody(service.list(OPERATOR, COMPANY, { q: terms }))).toMatchObject({
      error: 'TooManySearchTerms',
    });
    expect(searchIndex.matchAssetIds).not.toHaveBeenCalled();
  });
});
