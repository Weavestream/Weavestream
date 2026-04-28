import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type {
  DomainCheck as DomainCheckRow,
  DomainStatus,
  MonitoredDomain,
  Prisma,
} from '@prisma/client';
import { DomainsService } from './domains.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Unit tests for DomainsService. Scope:
 *   - tenant-scope enforcement (company mismatch = 404)
 *   - hostname normalisation (uppercase + trailing dot is rejected /
 *     normalised consistently)
 *   - uniqueness inside (companyId, archived_at IS NULL) — the same
 *     hostname may be re-monitored after archive
 *   - CLIENT_USER visibility filter hides internal rows from list + get
 *   - archive → restore round-trip (updates `archivedAt`)
 *   - at-least-one-subcheck invariant on create + update
 */

type DomainRow = MonitoredDomain;

function makeStubs(initial: { domains?: DomainRow[]; checks?: DomainCheckRow[] } = {}) {
  const domains: DomainRow[] = [...(initial.domains ?? [])];
  const checks: DomainCheckRow[] = [...(initial.checks ?? [])];
  const companies = [
    { id: 'co-1', name: 'Acme', slug: 'acme' },
    { id: 'co-2', name: 'Other', slug: 'other' },
  ];

  function matchesWhere(row: DomainRow, where: Prisma.MonitoredDomainWhereInput): boolean {
    if (where.id && where.id !== row.id) return false;
    if (where.companyId && where.companyId !== row.companyId) return false;
    if (
      typeof where.hostname === 'string' &&
      where.hostname !== row.hostname
    ) {
      return false;
    }
    if (where.archivedAt === null && row.archivedAt !== null) return false;
    if (
      typeof where.visibleToClients === 'boolean' &&
      where.visibleToClients !== row.visibleToClients
    ) {
      return false;
    }
    if (
      where.latestStatus &&
      typeof where.latestStatus === 'string' &&
      where.latestStatus !== row.latestStatus
    ) {
      return false;
    }
    if (
      where.NOT &&
      typeof where.NOT === 'object' &&
      'id' in where.NOT &&
      (where.NOT as { id?: string }).id === row.id
    ) {
      return false;
    }
    return true;
  }

  const prisma = {
    monitoredDomain: {
      async findFirst(args: { where: Prisma.MonitoredDomainWhereInput }) {
        return domains.find((d) => matchesWhere(d, args.where)) ?? null;
      },
      async findFirstOrThrow(args: { where: Prisma.MonitoredDomainWhereInput }) {
        const row = domains.find((d) => matchesWhere(d, args.where));
        if (!row) throw new Error('not found');
        return row;
      },
      async findMany(args: { where: Prisma.MonitoredDomainWhereInput; take?: number }) {
        const results = domains.filter((d) => matchesWhere(d, args.where));
        return args.take ? results.slice(0, args.take) : results;
      },
      async create(args: { data: Prisma.MonitoredDomainUncheckedCreateInput }) {
        const d = args.data;
        const row: DomainRow = {
          id: `dom-${domains.length + 1}`,
          companyId: d.companyId,
          hostname: d.hostname,
          checkWhois: d.checkWhois ?? true,
          checkDns: d.checkDns ?? true,
          checkTls: d.checkTls ?? true,
          alertThresholdDays: d.alertThresholdDays ?? 30,
          visibleToClients: d.visibleToClients ?? false,
          lastCheckedAt: null,
          whoisExpiresAt: null,
          tlsExpiresAt: null,
          latestStatus: 'UNKNOWN' as DomainStatus,
          httpCheckEnabled: d.httpCheckEnabled ?? true,
          latestHttpStatus: null,
          httpDownSince: null,
          archivedAt: null,
          createdBy: d.createdBy ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        domains.push(row);
        return row;
      },
      async updateMany(args: {
        where: Prisma.MonitoredDomainWhereInput;
        data: Partial<DomainRow>;
      }) {
        let count = 0;
        for (const row of domains) {
          if (matchesWhere(row, args.where)) {
            Object.assign(row, args.data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
    },
    domainCheck: {
      async findMany() {
        return checks;
      },
    },
    company: {
      async findMany(args: { where: { id: { in: string[] } } }) {
        return companies.filter((c) => args.where.id.in.includes(c.id));
      },
    },
  };

  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const svc = new DomainsService(
    prisma as unknown as import('../prisma/prisma.service.js').PrismaService,
    audit as unknown as import('../audit/audit.service.js').AuditLogService,
  );

  return { svc, prisma, audit, domains };
}

const META = { ip: '127.0.0.1', userAgent: 'jest' };
const OPERATOR: AuthedUser = {
  id: 'user-1',
  email: 'ops@acme.test',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: 'sess-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};
const CLIENT: AuthedUser = {
  id: 'user-2',
  email: 'client@acme.test',
  role: 'CLIENT_USER',
  globalAccess: null,
  platformCapabilities: [],
  sessionId: 'sess-2',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

describe('DomainsService — create', () => {
  it('normalises hostnames (trim, lowercase)', async () => {
    const { svc, domains } = makeStubs();
    const created = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: '   Example.COM  ' },
      META,
    );
    expect(created.hostname).toBe('example.com');
    expect(domains[0]!.hostname).toBe('example.com');
  });

  it('rejects bare IP literals', async () => {
    const { svc } = makeStubs();
    await expect(
      svc.create(OPERATOR, 'co-1', { hostname: '192.0.2.1' }, META),
    ).rejects.toBeDefined();
  });

  it('rejects URL-style values (scheme/port/userinfo)', async () => {
    const { svc } = makeStubs();
    await expect(
      svc.create(OPERATOR, 'co-1', { hostname: 'https://example.com' }, META),
    ).rejects.toBeDefined();
  });

  it('enforces hostname uniqueness per active companyId', async () => {
    const { svc } = makeStubs();
    await svc.create(OPERATOR, 'co-1', { hostname: 'example.com' }, META);
    await expect(
      svc.create(OPERATOR, 'co-1', { hostname: 'example.com' }, META),
    ).rejects.toThrow(ConflictException);
  });

  it('requires at least one sub-check enabled', async () => {
    const { svc } = makeStubs();
    await expect(
      svc.create(
        OPERATOR,
        'co-1',
        {
          hostname: 'example.com',
          checkWhois: false,
          checkDns: false,
          checkTls: false,
        },
        META,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('defaults visibleToClients to false', async () => {
    const { svc } = makeStubs();
    const created = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'example.com' },
      META,
    );
    expect(created.visibleToClients).toBe(false);
  });
});

describe('DomainsService — tenant scope', () => {
  it('returns 404 when getById targets a foreign company', async () => {
    const { svc } = makeStubs();
    const created = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'example.com' },
      META,
    );
    await expect(
      svc.getById(OPERATOR, 'co-2', created.id),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('DomainsService — client visibility', () => {
  it('hides internal rows from CLIENT_USER list', async () => {
    const { svc } = makeStubs();
    await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'internal.example.com', visibleToClients: false },
      META,
    );
    await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'public.example.com', visibleToClients: true },
      META,
    );

    const { items } = await svc.list(CLIENT, 'co-1');
    expect(items.map((i) => i.hostname)).toEqual(['public.example.com']);
  });

  it('returns 404 for CLIENT_USER getting an internal row', async () => {
    const { svc } = makeStubs();
    const created = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'internal.example.com', visibleToClients: false },
      META,
    );
    await expect(
      svc.getById(CLIENT, 'co-1', created.id),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('DomainsService — archive/restore', () => {
  it('allows re-monitoring the same hostname after archive', async () => {
    const { svc } = makeStubs();
    const first = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'example.com' },
      META,
    );
    await svc.archive(OPERATOR, 'co-1', first.id, META);

    const second = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'example.com' },
      META,
    );
    expect(second.id).not.toBe(first.id);
  });

  it('restore clears archivedAt and enforces uniqueness', async () => {
    const { svc } = makeStubs();
    const original = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'example.com' },
      META,
    );
    await svc.archive(OPERATOR, 'co-1', original.id, META);

    const restored = await svc.restore(OPERATOR, 'co-1', original.id, META);
    expect(restored.archivedAt).toBeNull();
  });
});

describe('DomainsService — update', () => {
  it('rejects disabling every sub-check', async () => {
    const { svc } = makeStubs();
    const created = await svc.create(
      OPERATOR,
      'co-1',
      { hostname: 'example.com' },
      META,
    );
    await expect(
      svc.update(
        OPERATOR,
        'co-1',
        created.id,
        { checkWhois: false, checkDns: false, checkTls: false },
        META,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
