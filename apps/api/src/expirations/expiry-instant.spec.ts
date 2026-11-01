/**
 * @jest-environment <rootDir>/../jest.timezone-environment.js
 */
import { ExpirationsService } from './expirations.service.js';
import { ExpirationDismissalsService } from './expiration-dismissals.service.js';
import { AlertsRunnerService } from '../alerts/alerts-runner.service.js';

/**
 * A zone-less DATETIME value (what a `datetime-local` input saves) must give
 * the same expiry instant on every server zone: the API runs on UTC in the
 * container but on local time in dev. Each case runs under several process
 * zones and expects identical output.
 *
 * `setProcessTimeZone` comes from the custom test environment above.
 * Assigning `process.env.TZ` in a spec does NOT change the zone: Jest gives
 * the spec a copy of `process.env`.
 */
declare const setProcessTimeZone: (tz: string) => void;

const CO = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';
const FIELD = '33333333-3333-4333-8333-333333333333';
const DATE_FIELD = '44444444-4444-4444-8444-444444444444';
const ACTOR = { id: '55555555-5555-4555-8555-555555555555', role: 'OPERATOR' } as never;

// 23 hours before the zone-less value read as UTC, so `daysUntil` is 0. Read
// in Los Angeles (the old bug) it would be 30 hours away, so `daysUntil` 1.
const NOW = Date.parse('2026-06-30T16:00:00.000Z');
const ZONE_LESS = '2026-07-01T15:00';
const EXPECTED_AT = '2026-07-01T15:00:00.000Z';
const CALENDAR_DAY = '2026-07-03';
const EXPECTED_DAY_AT = '2026-07-03T00:00:00.000Z';

const RUNTIME_ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati'] as const;

function prismaMock() {
  return {
    assetField: {
      findMany: jest.fn(async () => [
        { id: FIELD, slug: 'cert-expiry', name: 'Cert expiry', fieldType: 'DATETIME', options: { isExpiry: true } },
        { id: DATE_FIELD, slug: 'warranty', name: 'Warranty', fieldType: 'DATE', options: { isExpiry: true } },
      ]),
      findFirst: jest.fn(async () => ({ id: FIELD })),
    },
    assetFieldValue: {
      findMany: jest.fn(async () => [
        { assetFieldId: FIELD, value: ZONE_LESS, asset: assetRow() },
        { assetFieldId: DATE_FIELD, value: CALENDAR_DAY, asset: assetRow() },
      ]),
      findFirst: jest.fn(async () => ({ value: ZONE_LESS })),
    },
    asset: { findFirst: jest.fn(async () => ({ id: ASSET, assetLayoutId: 'layout-1' })) },
    company: { findMany: jest.fn(async () => [{ id: CO, name: 'Acme', slug: 'acme' }]) },
    expirationDismissal: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'd-1', ...create })),
    },
  };
}

function assetRow() {
  return {
    id: ASSET,
    name: 'Firewall',
    companyId: CO,
    assetLayout: { id: 'layout-1', name: 'Network', icon: null, color: null },
  };
}

/** Minutes UTC is ahead of local time on NOW's date, as `getTimezoneOffset` gives it. */
const OFFSET_MINUTES: Record<string, number> = {
  UTC: 0,
  'America/Los_Angeles': 420,
  'Asia/Kolkata': -330,
  'Pacific/Kiritimati': -840,
};

/** Switch the real process zone, and fail loudly if it did not switch. */
function useServerZone(tz: string): void {
  setProcessTimeZone(tz);
  expect(new Date(NOW).getTimezoneOffset()).toBe(OFFSET_MINUTES[tz]);
}

describe('zone-less expiry values do not depend on the server zone', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(RUNTIME_ZONES)('Expiring-soon feed on server zone %s', async (tz) => {
    useServerZone(tz);
    const svc = new ExpirationsService(
      prismaMock() as never,
      { loadMap: jest.fn().mockResolvedValue(new Map()) } as never,
    );
    const s = svc as unknown as Record<string, jest.Mock>;
    s.listDomainExpirations = jest.fn().mockResolvedValue([]);
    s.listPasswordExpirations = jest.fn().mockResolvedValue([]);

    const rows = await svc.list({ actor: ACTOR });

    expect(rows.map((r) => [r.kind === 'asset-field' && r.fieldId, r.expiresAt, r.daysUntil])).toEqual([
      [FIELD, EXPECTED_AT, 0],
      // DATE keeps its calendar day, pinned to midnight UTC.
      [DATE_FIELD, EXPECTED_DAY_AT, 2],
    ]);
  });

  it.each(RUNTIME_ZONES)('expiry alerts on server zone %s', async (tz) => {
    useServerZone(tz);
    const runner = new AlertsRunnerService(prismaMock() as never, {} as never);
    const collect = (runner as unknown as {
      collectExpirations: (config: unknown) => Promise<Array<{ expiresAt: string; daysUntil: number }>>;
    }).collectExpirations.bind(runner);

    const items = await collect({ triggerDays: 30, expirationKinds: ['asset'], companyId: null });

    expect(items.map((i) => [i.expiresAt, i.daysUntil])).toEqual([
      [EXPECTED_AT, 0],
      [EXPECTED_DAY_AT, 2],
    ]);
  });

  it.each(RUNTIME_ZONES)('dismiss accepts the feed due date on server zone %s', async (tz) => {
    useServerZone(tz);
    const prisma = prismaMock();
    Object.assign(prisma, { $transaction: (fn: (tx: unknown) => unknown) => fn(prisma) });
    const svc = new ExpirationDismissalsService(
      prisma as never,
      { logWithClient: jest.fn().mockResolvedValue(undefined) } as never,
      { can: jest.fn().mockResolvedValue({ allowed: true }) } as never,
    );

    await expect(
      svc.dismiss(
        ACTOR,
        CO,
        { kind: 'asset-field', entityId: ASSET, source: FIELD, dueAt: EXPECTED_AT },
        { ip: '198.51.100.7', userAgent: 'jest' },
      ),
    ).resolves.toBeDefined();
  });
});
