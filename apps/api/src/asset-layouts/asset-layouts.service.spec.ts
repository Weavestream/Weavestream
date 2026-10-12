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

describe('AssetLayoutsService.addField', () => {
  const META = { ip: '203.0.113.1', userAgent: 'jest' };
  const NEW = {
    name: 'Serial number',
    slug: 'serial_number',
    fieldType: 'TEXT' as const,
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: false,
    showInTable: false,
    options: {},
  };

  /**
   * In-memory layout row. `onRead` runs after each transactional read so a
   * test can play a concurrent writer committing between our read and write.
   */
  function harness(onRead: (state: { version: number; fields: MockFieldRow[] }, read: number) => void = () => {}) {
    const state = { version: 1, fields: [makeField()] };
    let reads = 0;
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      assetLayout: {
        findUnique: jest.fn(async () => {
          const snapshot = { ...makeLayoutRow(state.fields.map((f) => ({ ...f }))), version: state.version };
          onRead(state, ++reads);
          return snapshot;
        }),
        updateMany: jest.fn(async ({ where }: { where: { version: number } }) => {
          if (where.version !== state.version) return { count: 0 };
          state.version += 1;
          return { count: 1 };
        }),
      },
      assetField: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...makeField(), ...data, id: 'f-new', archivedAt: null } as MockFieldRow;
          state.fields.push(row);
          created.push(data);
          return row;
        }),
        updateMany: jest.fn(),
      },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const audit = { log: jest.fn() };
    // Applies a default, like a strategy schema may: the parsed value is what gets stored.
    const registry = {
      get: () => ({ optionsSchema: { safeParse: (v: object) => ({ success: true, data: { maxLength: 255, ...v } }) } }),
    };
    const service = new AssetLayoutsService(prisma as never, audit as never, registry as never, {} as never);
    return { service, state, tx, audit, created };
  }

  it('keeps a field another request added after our read, and retries on fresh state', async () => {
    const { service, state, tx, audit, created } = harness((s, read) => {
      if (read === 1) {
        s.fields.push(makeField({ id: 'f-other', slug: 'other', name: 'Other', position: 1, isPrimary: false }));
        s.version += 1;
      }
    });
    const result = await service.addField(OPERATOR, 'l-1', NEW, META);
    expect(result).toMatchObject({ created: true, field: { id: 'f-new', slug: 'serial_number', isPrimary: false } });
    expect(state.fields.map((f) => f.slug)).toEqual(['hostname', 'other', 'serial_number']);
    expect(tx.assetField.updateMany).not.toHaveBeenCalled();
    expect(created).toEqual([
      expect.objectContaining({ slug: 'serial_number', position: 2, isPrimary: false, options: { maxLength: 255 } }),
    ]);
    expect(tx.assetLayout.findUnique).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'layout.field.added', entityId: 'f-new' }));
  });

  it('returns a live field with the same slug untouched instead of adding one', async () => {
    const { service, tx, audit } = harness();
    const result = await service.addField(OPERATOR, 'l-1', { ...NEW, slug: 'hostname' }, META);
    expect(result).toMatchObject({ created: false, field: { id: 'f-1' } });
    expect(tx.assetField.create).not.toHaveBeenCalled();
    expect(tx.assetLayout.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('gives up with a conflict when the layout keeps changing', async () => {
    const { service, tx } = harness((s) => {
      s.version += 1;
    });
    await expect(service.addField(OPERATOR, 'l-1', NEW, META)).rejects.toThrow(/layout changed/);
    expect(tx.assetField.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid slug before touching the database', async () => {
    const { service, tx } = harness();
    await expect(service.addField(OPERATOR, 'l-1', { ...NEW, slug: 'Bad Slug!' }, META)).rejects.toThrow();
    expect(tx.assetLayout.findUnique).not.toHaveBeenCalled();
  });
});
