import { AssetLayoutsService } from './asset-layouts.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Unit coverage for the Phase 2c CLIENT_USER field filtering on the
 * layout read paths.
 *
 * The authoritative filter is the Prisma relation `WHERE` inside
 * `fieldsInclude` (CLAUDE.md §1 — authorization at the query layer), so
 * the first assertions here are on the *query arguments*, not on the
 * serialized output. The serializer repeats the filter as
 * defense-in-depth; the last case proves that a row slipping past the
 * query (e.g. a future refactor dropping the include `where`) is still
 * withheld from the response.
 */

type MockFieldRow = {
  id: string;
  name: string;
  slug: string;
  fieldType: string;
  position: number;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  showInTable: boolean;
  options: Record<string, unknown>;
  archivedAt: Date | null;
};

function makeField(over: Partial<MockFieldRow> = {}): MockFieldRow {
  return {
    id: 'f-1',
    name: 'Hostname',
    slug: 'hostname',
    fieldType: 'TEXT',
    position: 0,
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: true,
    showInTable: false,
    options: {},
    archivedAt: null,
    ...over,
  };
}

function makeLayoutRow(fields: MockFieldRow[]) {
  return {
    id: 'l-1',
    name: 'Devices',
    slug: 'devices',
    icon: 'dns',
    color: '#0d7d72',
    isActive: true,
    position: 0,
    version: 1,
    archivedAt: null,
    createdBy: null,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    fields,
  };
}

function makePrisma() {
  return {
    assetLayout: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new AssetLayoutsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const OPERATOR: AuthedUser = {
  id: 'u-op',
  email: 'op@example.com',
  role: 'OPERATOR',
} as unknown as AuthedUser;

const CLIENT: AuthedUser = {
  id: 'u-client',
  email: 'client@example.com',
  role: 'CLIENT_USER',
} as unknown as AuthedUser;

describe('AssetLayoutsService read-path field visibility', () => {
  describe('list', () => {
    it('applies visibleToClients in the relation WHERE for CLIENT_USER actors', async () => {
      const prisma = makePrisma();
      prisma.assetLayout.findMany.mockResolvedValue([]);
      await makeService(prisma).list(CLIENT);
      expect(prisma.assetLayout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            fields: {
              where: { visibleToClients: true },
              orderBy: { position: 'asc' },
            },
          },
        }),
      );
    });

    it('does not constrain fields for internal roles', async () => {
      const prisma = makePrisma();
      prisma.assetLayout.findMany.mockResolvedValue([]);
      await makeService(prisma).list(OPERATOR);
      expect(prisma.assetLayout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { fields: { orderBy: { position: 'asc' } } },
        }),
      );
    });
  });

  describe('get', () => {
    it('applies visibleToClients in the relation WHERE for CLIENT_USER actors', async () => {
      const prisma = makePrisma();
      prisma.assetLayout.findUnique.mockResolvedValue(makeLayoutRow([]));
      await makeService(prisma).get(CLIENT, 'l-1');
      expect(prisma.assetLayout.findUnique).toHaveBeenCalledWith({
        where: { id: 'l-1' },
        include: {
          fields: {
            where: { visibleToClients: true },
            orderBy: { position: 'asc' },
          },
        },
      });
    });

    it('returns all fields to internal roles', async () => {
      const prisma = makePrisma();
      prisma.assetLayout.findUnique.mockResolvedValue(
        makeLayoutRow([
          makeField(),
          makeField({ id: 'f-2', slug: 'internal_note', name: 'Internal note', visibleToClients: false, isPrimary: false, position: 1 }),
        ]),
      );
      const layout = await makeService(prisma).get(OPERATOR, 'l-1');
      expect(layout.fields.map((f) => f.slug)).toEqual(['hostname', 'internal_note']);
    });

    it('serializer withholds a non-visible field from CLIENT_USER even if the query returns it (defense-in-depth)', async () => {
      const prisma = makePrisma();
      // Simulate a fake/refactor that ignored the include WHERE.
      prisma.assetLayout.findUnique.mockResolvedValue(
        makeLayoutRow([
          makeField(),
          makeField({ id: 'f-2', slug: 'internal_note', name: 'Internal note', visibleToClients: false, isPrimary: false, position: 1 }),
        ]),
      );
      const layout = await makeService(prisma).get(CLIENT, 'l-1');
      expect(layout.fields.map((f) => f.slug)).toEqual(['hostname']);
    });
  });
});
