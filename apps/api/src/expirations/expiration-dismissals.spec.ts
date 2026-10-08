import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { expirationDismissalKey } from '@weavestream/shared';
import { ExpirationDismissalsService } from './expiration-dismissals.service.js';
import { ExpirationsService } from './expirations.service.js';
import { dismissalKeyOf } from '../alerts/alerts-runner.service.js';

const CO = '11111111-1111-4111-8111-111111111111';
const DOMAIN = '22222222-2222-4222-8222-222222222222';
const PW = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR = { id: ACTOR_ID, role: 'OPERATOR' } as never;
const META = { ip: '198.51.100.7', userAgent: 'jest' };

function harness(
  opts: { allowed?: boolean; domainInCompany?: boolean; pwRestricted?: boolean; fieldClientVisible?: boolean } = {},
) {
  const store: Array<Record<string, unknown>> = [];
  const prisma = {
    expirationDismissal: {
      findMany: jest.fn(async ({ where }: { where: { companyId?: string } }) =>
        store.filter((r) => !where.companyId || r.companyId === where.companyId),
      ),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: '55555555-5555-4555-8555-555555555555', createdAt: new Date(), ...create };
        store.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: { id: string; companyId: string } }) =>
        store.find((r) => r.id === where.id && r.companyId === where.companyId) ?? null,
      ),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    monitoredDomain: {
      findFirst: jest.fn(async () =>
        opts.domainInCompany === false
          ? null
          : { whoisExpiresAt: new Date('2027-01-01T00:00:00.000Z'), tlsExpiresAt: new Date(domainInput.dueAt) },
      ),
    },
    assetFieldValue: { findFirst: jest.fn(async () => ({ value: '2026-01-01' })) },
    asset: { findFirst: jest.fn(async () => ({ assetLayoutId: 'layout-1' })) },
    assetField: {
      findFirst: jest.fn(async ({ where }: { where: { visibleToClients?: boolean } }) =>
        where.visibleToClients && opts.fieldClientVisible === false ? null : { id: PW },
      ),
    },
    password: {
      findFirst: jest.fn(async () => ({
        visibleToClients: false,
        restrictedToUserIds: opts.pwRestricted ? ['someone-else'] : [],
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        lastRotatedAt: null,
        rotationReminderDays: null,
      })),
    },
  };
  const audit = { logWithClient: jest.fn().mockResolvedValue(undefined) };
  Object.assign(prisma, { $transaction: (fn: (tx: unknown) => unknown) => fn(prisma) });
  const permissions = { can: jest.fn().mockResolvedValue({ allowed: opts.allowed ?? true }) };
  const svc = new ExpirationDismissalsService(prisma as never, audit as never, permissions as never);
  return { svc, prisma, audit, permissions, store };
}

const domainInput = {
  kind: 'domain' as const,
  entityId: DOMAIN,
  source: 'tls',
  dueAt: '2023-09-26T02:43:53.000Z',
  note: 'client is moving hosts',
};

describe('ExpirationDismissalsService', () => {
  it('dismisses with the per-kind manage permission, and audits it by reference', async () => {
    const { svc, permissions, audit } = harness();
    await svc.dismiss(ACTOR, CO, domainInput, META);
    expect(permissions.can).toHaveBeenCalledWith(ACTOR, 'domain.manage', { companyId: CO });
    expect(audit.logWithClient.mock.calls[0][1]).toMatchObject({ action: 'expiration.dismiss', companyId: CO });
  });

  it('refuses without the manage permission', async () => {
    await expect(harness({ allowed: false }).svc.dismiss(ACTOR, CO, domainInput, META)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses an item that is not in this company (IDOR)', async () => {
    await expect(
      harness({ domainInCompany: false }).svc.dismiss(ACTOR, CO, domainInput, META),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a password the actor cannot read', async () => {
    await expect(
      harness({ pwRestricted: true }).svc.dismiss(
        ACTOR,
        CO,
        { kind: 'password', entityId: PW, source: 'expiry', dueAt: '2026-11-01T00:00:00.000Z' },
        META,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects unknown sources and non-uuid asset fields', async () => {
    const { svc } = harness();
    await expect(svc.dismiss(ACTOR, CO, { ...domainInput, source: 'whois' }, META)).rejects.toThrow(/Unknown domain source/);
    await expect(
      svc.dismiss(ACTOR, CO, { kind: 'asset-field', entityId: DOMAIN, source: 'warranty', dueAt: '2026-01-01' }, META),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('client users cannot dismiss an MSP-internal asset field', async () => {
    const client = { id: ACTOR_ID, role: 'CLIENT_USER' } as never;
    const input = { kind: 'asset-field' as const, entityId: DOMAIN, source: PW, dueAt: '2026-01-01' };
    await expect(harness({ fieldClientVisible: false }).svc.dismiss(client, CO, input, META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(harness({ fieldClientVisible: false }).svc.dismiss(ACTOR, CO, input, META)).resolves.toBeDefined();
  });

  it('only dismisses the date the item is due on now', async () => {
    await expect(
      harness().svc.dismiss(ACTOR, CO, { ...domainInput, dueAt: '2030-01-01T00:00:00.000Z' }, META),
    ).rejects.toThrow(/not the current due date/);
  });

  it('restore re-checks access to the item', async () => {
    const h = harness();
    await h.svc.dismiss(ACTOR, CO, domainInput, META);
    h.prisma.monitoredDomain.findFirst.mockResolvedValueOnce(null);
    await expect(
      h.svc.restore(ACTOR, CO, '55555555-5555-4555-8555-555555555555', META),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('restore only finds dismissals in this company', async () => {
    const { svc } = harness();
    await svc.dismiss(ACTOR, CO, domainInput, META);
    await expect(
      svc.restore(ACTOR, '99999999-9999-4999-8999-999999999999', '55555555-5555-4555-8555-555555555555', META),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ExpirationsService with dismissals', () => {
  const row = (expiresAt: string) => ({
    kind: 'domain',
    companyId: CO,
    companyName: 'Acme',
    companySlug: 'acme',
    domainId: DOMAIN,
    hostname: 'example.org',
    source: 'tls',
    expiresAt,
    daysUntil: -10,
    status: 'EXPIRED',
  });

  function feed(dismissedAt: string | null, rows: unknown[]) {
    const map = new Map();
    if (dismissedAt) {
      map.set(expirationDismissalKey('domain', DOMAIN, 'tls', dismissedAt), {
        id: '55555555-5555-4555-8555-555555555555',
        note: 'moving hosts',
        createdAt: new Date('2026-10-07T00:00:00Z'),
        dismissedBy: null,
      });
    }
    const svc = new ExpirationsService({} as never, { loadMap: jest.fn().mockResolvedValue(map) } as never);
    const s = svc as unknown as Record<string, jest.Mock>;
    s.listAssetFieldExpirations = jest.fn().mockResolvedValue([]);
    s.listDomainExpirations = jest.fn().mockResolvedValue(rows);
    s.listPasswordExpirations = jest.fn().mockResolvedValue([]);
    return svc;
  }

  it('hides a dismissed row, and brings it back when the due date changes', async () => {
    const dismissed = '2023-09-26T02:43:53.000Z';
    await expect(feed(dismissed, [row(dismissed)]).list({ actor: ACTOR })).resolves.toEqual([]);
    const renewed = '2026-11-14T18:01:01.000Z';
    await expect(feed(dismissed, [row(renewed)]).list({ actor: ACTOR })).resolves.toHaveLength(1);
  });

  it('hides the operator note and user from client users', async () => {
    const dismissed = '2023-09-26T02:43:53.000Z';
    const client = { id: ACTOR_ID, role: 'CLIENT_USER' } as never;
    const out = await feed(dismissed, [row(dismissed)]).list({ actor: client, includeDismissed: true });
    expect(out[0]).toMatchObject({ dismissal: { note: null, dismissedBy: null } });
  });

  it('returns dismissed rows annotated when asked', async () => {
    const dismissed = '2023-09-26T02:43:53.000Z';
    const out = await feed(dismissed, [row(dismissed)]).list({ actor: ACTOR, includeDismissed: true });
    expect(out[0]).toMatchObject({ dismissal: { id: '55555555-5555-4555-8555-555555555555', note: 'moving hosts' } });
  });
});

describe('alert items map to the same dismissal key as feed rows', () => {
  it.each([
    [{ id: `${DOMAIN}:tls`, kind: 'domain_tls' }, expirationDismissalKey('domain', DOMAIN, 'tls', '2026-01-01T00:00:00Z')],
    [{ id: `${DOMAIN}:registrar`, kind: 'domain_registrar' }, expirationDismissalKey('domain', DOMAIN, 'registrar', '2026-01-01T00:00:00Z')],
    [{ id: `${PW}:rotation`, kind: 'password', source: 'rotation' }, expirationDismissalKey('password', PW, 'rotation', '2026-01-01T00:00:00Z')],
    [{ id: `${PW}:${DOMAIN}`, kind: 'asset' }, expirationDismissalKey('asset-field', PW, DOMAIN, '2026-01-01T00:00:00Z')],
  ])('%o', (item, key) => {
    expect(dismissalKeyOf({ label: 'x', daysUntil: 0, companyId: CO, expiresAt: '2026-01-01T00:00:00Z', ...item } as never)).toBe(key);
  });
});

describe('dashboard domain alerts respect dismissals', () => {
  // One fixed date for both calls, so the dismissal key matches exactly.
  const TLS = new Date(Date.now() - 5 * 86_400_000);
  async function alerts(domain: Record<string, unknown>, dismissedKeys: Array<[string, string]>) {
    const { DomainsService } = await import('../domains/domains.service.js');
    const now = Date.now();
    const base = {
      id: DOMAIN,
      companyId: CO,
      hostname: 'example.org',
      latestStatus: 'EXPIRED',
      latestScore: 80,
      alertThresholdDays: 30,
      visibleToClients: false,
      whoisExpiresAt: new Date(now + 365 * 86_400_000),
      tlsExpiresAt: TLS,
      ...domain,
    };
    const prisma = {
      monitoredDomain: { findMany: jest.fn().mockResolvedValue([base]) },
      company: { findMany: jest.fn().mockResolvedValue([{ id: CO, name: 'Acme', slug: 'acme' }]) },
      expirationDismissal: {
        findMany: jest.fn().mockResolvedValue(
          dismissedKeys.map(([source, at]) => ({
            kind: 'domain',
            entityId: DOMAIN,
            source,
            dueAt: new Date(at),
          })),
        ),
      },
    };
    const svc = new DomainsService(prisma as never, {} as never);
    return { out: await svc.listAlertsAcrossCompanies(), tls: (base.tlsExpiresAt as Date).toISOString() };
  }

  it('drops an expired-cert domain once that cert date is dismissed', async () => {
    const first = await alerts({}, []);
    expect(first.out).toHaveLength(1);
    const { out } = await alerts({}, [['tls', first.tls]]);
    expect(out).toHaveLength(0);
  });

  it('keeps it when it is also on the panel for a low score', async () => {
    const first = await alerts({ latestScore: 20 }, []);
    const { out } = await alerts({ latestScore: 20 }, [['tls', first.tls]]);
    expect(out).toHaveLength(1);
  });
});
