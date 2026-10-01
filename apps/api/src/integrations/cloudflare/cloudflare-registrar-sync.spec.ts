import type { MonitoredDomain } from '@prisma/client';
import type { CloudflareRegistrarDomain } from '../drivers/cloudflare/cloudflare-api.client.js';
import { CloudflareRegistrarSyncService, matchRow } from './cloudflare-registrar-sync.service.js';

const INT = 'int-1';
const HODY = '00000000-0000-4000-8000-0000000000aa';

function row(p: Partial<MonitoredDomain>): MonitoredDomain {
  return {
    id: p.id ?? `d-${Math.random()}`,
    companyId: HODY,
    hostname: 'example.com',
    source: 'MANUAL',
    integrationId: null,
    archivedAt: null,
    registrarMissingSince: null,
    ...p,
  } as MonitoredDomain;
}

function cf(name: string, p: Partial<CloudflareRegistrarDomain> = {}): CloudflareRegistrarDomain {
  return {
    name,
    cloudflareRegistration: true,
    registrar: 'Cloudflare',
    autoRenew: true,
    locked: true,
    registeredAt: new Date('2020-01-01'),
    expiresAt: new Date('2027-01-01'),
    registryStatuses: ['clientTransferProhibited'],
    nameservers: ['a.ns.cloudflare.com'],
    hasZone: true,
    ...p,
  };
}

function harness(opts: {
  rows: MonitoredDomain[];
  cfDomains: CloudflareRegistrarDomain[];
  /** Resolved company id in config; '' = sync not configured. */
  companyId?: string;
}) {
  const rows = opts.rows;
  const matches = (r: MonitoredDomain, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => (r as never)[k] === v);
  const prisma = {
    integration: {
      findUnique: jest.fn(async () => ({
        id: INT,
        driver: 'cloudflare',
        status: 'ACTIVE',
        config: { accountId: 'acct', domainsCompanyId: HODY },
      })),
    },
    company: { findUnique: jest.fn(async () => ({ id: HODY, archivedAt: null })) },
    monitoredDomain: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
      create: jest.fn(async ({ data }: { data: Partial<MonitoredDomain> }) => {
        const r = row({ id: `new-${rows.length}`, ...data });
        rows.push(r);
        return r;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: { in: string[] } }; data: object }) => {
          for (const r of rows) if (where.id.in.includes(r.id)) Object.assign(r, data);
          return { count: where.id.in.length };
        },
      ),
    },
  };
  const integrations = {
    loadDriverContext: jest.fn(async () => ({
      config: {
        accountId: 'acct',
        ...(opts.companyId === '' ? {} : { domainsCompanyId: opts.companyId ?? HODY }),
      },
      secret: { apiToken: 't' },
    })),
  };
  const driver = { listRegistrarDomains: jest.fn(async () => opts.cfDomains) };
  const drivers = { getSecurity: jest.fn(() => driver) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const env = {
    values: {
      INTEGRATION_HTTP_TIMEOUT_MS: 1000,
      INTEGRATION_HTTP_MAX_RETRIES: 0,
      INTEGRATION_HTTP_BACKOFF_MS: 0,
    },
  };
  const kv = new Map<string, string>();
  const redis = {
    client: {
      set: jest.fn(async (k: string, v: string, ..._rest: unknown[]) => {
        if (kv.has(k)) return null;
        kv.set(k, v);
        return 'OK';
      }),
      // Mirrors the compare-and-delete Lua script.
      exists: jest.fn(async (k: string) => (kv.has(k) ? 1 : 0)),
      // Mirrors the two Lua scripts: compare-and-renew, compare-and-delete.
      eval: jest.fn(async (script: string, _n: number, k: string, token: string) => {
        if (kv.get(k) !== token) return 0;
        if (!script.includes('expire')) kv.delete(k);
        return 1;
      }),
    },
  };
  const add = jest.fn().mockResolvedValue(undefined);
  const queues = { get: jest.fn(() => ({ add })) };
  const svc = new CloudflareRegistrarSyncService(
    prisma as never,
    integrations as never,
    drivers as never,
    audit as never,
    env as never,
    redis as never,
    queues as never,
  );
  return { svc, rows, audit, driver, kv, add };
}

describe('matchRow', () => {
  const m = (rows: MonitoredDomain[]) => matchRow(rows, INT, 'acct', HODY);

  it('updates the row this integration owns, wherever it was moved', () => {
    const owned = row({ id: 'owned', source: 'CLOUDFLARE', integrationId: INT, companyId: 'co-client' });
    expect(m([row({ id: 'mh' }), owned])).toEqual({ kind: 'update', row: owned });
  });

  it('leaves an archived owned row alone instead of recreating the domain', () => {
    const archived = row({ source: 'CLOUDFLARE', integrationId: INT, archivedAt: new Date() });
    expect(m([archived])).toEqual({ kind: 'skip', reason: 'archived' });
  });

  it('reclaims a row orphaned by a deleted integration for the same account only', () => {
    const orphan = row({ id: 'o', source: 'CLOUDFLARE', integrationId: null, cloudflareAccountId: 'acct' });
    expect(m([orphan])).toEqual({ kind: 'update', row: orphan });
    const otherAccount = row({ source: 'CLOUDFLARE', integrationId: null, cloudflareAccountId: 'acct-2' });
    expect(m([otherAccount]).kind).toBe('skip');
    // Same account, but another company: not this config's to take.
    const otherCompany = row({
      source: 'CLOUDFLARE',
      integrationId: null,
      cloudflareAccountId: 'acct',
      companyId: 'co-client',
    });
    expect(m([otherCompany]).kind).toBe('skip');
  });

  it('adopts manual rows only in the configured company', () => {
    const mine = row({ id: 'mine' });
    expect(m([mine])).toEqual({ kind: 'adopt', row: mine });
    expect(m([row({ companyId: 'co-client' })])).toEqual({
      kind: 'skip',
      reason: 'exists in another company',
    });
  });

  it('never takes another integration\'s row, and creates only when nothing exists', () => {
    expect(m([row({ source: 'CLOUDFLARE', integrationId: 'int-2' })]).kind).toBe('skip');
    expect(m([])).toEqual({ kind: 'create' });
  });
});

describe('CloudflareRegistrarSyncService.sync', () => {
  it('is a no-op when no domains company is configured', async () => {
    const { svc, driver } = harness({ rows: [], cfDomains: [], companyId: '' });
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ enabled: false });
    expect(driver.listRegistrarDomains).not.toHaveBeenCalled();
  });

  it('creates new domains in the default company, adopts manual rows, and leaves company assignment alone', async () => {
    const moved = row({
      id: 'moved',
      hostname: 'client.com',
      companyId: 'co-client',
      source: 'CLOUDFLARE',
      integrationId: INT,
    });
    const manual = row({ id: 'manual', hostname: 'acme.dev' });
    const { svc, rows } = harness({
      rows: [moved, manual],
      cfDomains: [cf('client.com'), cf('acme.dev'), cf('New.Example.ORG')],
    });

    const res = await svc.sync(INT, 'u-1');

    expect(res).toEqual({ enabled: true, created: 1, updated: 1, adopted: 1, missing: 0 });
    expect(moved.companyId).toBe('co-client');
    expect(manual).toMatchObject({ source: 'CLOUDFLARE', integrationId: INT, registrarAutoRenew: true });
    const created = rows.find((r) => r.hostname === 'new.example.org');
    expect(created).toMatchObject({ companyId: HODY, source: 'CLOUDFLARE', createdBy: 'u-1' });
  });

  it('stamps missing once and never deletes', async () => {
    const gone = row({ id: 'gone', hostname: 'old.com', source: 'CLOUDFLARE', integrationId: INT });
    const { svc, rows } = harness({ rows: [gone], cfDomains: [] });

    await expect(svc.sync(INT, null)).resolves.toMatchObject({ missing: 1 });
    const stamped = gone.registrarMissingSince;
    expect(stamped).toBeInstanceOf(Date);
    expect(rows).toHaveLength(1);

    // A later sweep must not move the date forward.
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ missing: 0 });
    expect(gone.registrarMissingSince).toBe(stamped);
  });

  it('clears the missing stamp when the domain comes back', async () => {
    const back = row({
      hostname: 'back.com',
      source: 'CLOUDFLARE',
      integrationId: INT,
      registrarMissingSince: new Date('2026-01-01'),
    });
    const { svc } = harness({ rows: [back], cfDomains: [cf('back.com')] });
    await svc.sync(INT, null);
    expect(back.registrarMissingSince).toBeNull();
  });

  it('skips a hostname another Cloudflare integration already owns instead of duplicating it', async () => {
    const theirs = row({ hostname: 'shared.com', source: 'CLOUDFLARE', integrationId: 'int-2' });
    const { svc, rows } = harness({ rows: [theirs], cfDomains: [cf('shared.com')] });
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ created: 0, updated: 0 });
    expect(rows).toHaveLength(1);
  });

  it('audits one summary row by hostname, with no token or account secrets', async () => {
    const { svc, audit } = harness({ rows: [], cfDomains: [cf('a.com')] });
    await svc.sync(INT, null);
    const entry = audit.log.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: 'integration.cloudflare.registrar_sync',
      entityId: INT,
      after: expect.objectContaining({ createdHostnames: ['a.com'] }),
    });
    expect(JSON.stringify(entry)).not.toContain('apiToken');
  });

  it('refuses to run twice at once for one integration, and releases the lock after', async () => {
    const { svc, kv } = harness({ rows: [], cfDomains: [cf('a.com')] });
    kv.set(`lock:cf-registrar-sync:${INT}`, 'someone-else');
    await expect(svc.sync(INT, null)).rejects.toThrow(/already running/);
    // The other run's lock is untouched.
    expect(kv.get(`lock:cf-registrar-sync:${INT}`)).toBe('someone-else');

    kv.clear();
    await svc.sync(INT, null);
    expect(kv.size).toBe(0);
  });

  it('does not recreate a domain whose synced row was archived', async () => {
    const archived = row({ hostname: 'old.com', source: 'CLOUDFLARE', integrationId: INT, archivedAt: new Date() });
    const { svc, rows } = harness({ rows: [archived], cfDomains: [cf('old.com')] });
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ created: 0, updated: 0 });
    expect(rows).toHaveLength(1);
  });

  it('writes nothing if the lock was lost during the listing phase', async () => {
    const { svc, rows, kv, driver } = harness({ rows: [], cfDomains: [cf('a.com')] });
    driver.listRegistrarDomains.mockImplementationOnce(async () => {
      kv.set(`lock:cf-registrar-sync:${INT}`, 'stolen');
      return [cf('a.com')];
    });
    await expect(svc.sync(INT, null)).rejects.toThrow(/lost its lock/);
    expect(rows).toHaveLength(0);
  });

});

describe('CloudflareRegistrarSyncService.enqueue', () => {
  it('queues a manual job carrying who asked', async () => {
    const { svc, add } = harness({ rows: [], cfDomains: [] });
    await expect(svc.enqueue(INT, 'u-1')).resolves.toEqual({ queued: true });
    expect(add).toHaveBeenCalledWith(
      'manual',
      { integrationId: INT, triggeredBy: 'u-1' },
      expect.objectContaining({ jobId: `manual-domains-${INT}`, removeOnFail: true }),
    );
  });

  it('refuses up front while a sync holds the lock, instead of queueing a job that fails unseen', async () => {
    const { svc, add, kv } = harness({ rows: [], cfDomains: [] });
    kv.set(`lock:cf-registrar-sync:${INT}`, 'running');
    await expect(svc.enqueue(INT, 'u-1')).rejects.toThrow(/already running/);
    expect(add).not.toHaveBeenCalled();
  });
});
