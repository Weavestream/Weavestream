import { Logger } from '@nestjs/common';
import type { MonitoredDomain } from '@prisma/client';
import { DriverAuthError } from '../drivers/integration-driver.js';
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

/**
 * Stand-in for Postgres transaction-scoped advisory locks: `$executeRaw`
 * inside a `$transaction` waits for the key, and the transaction's end
 * releases it. Shared between harnesses to model two integrations' runs.
 */
function advisoryLocks() {
  const held = new Map<string, Promise<void>>();
  return {
    async acquire(key: string): Promise<() => void> {
      while (held.has(key)) await held.get(key);
      let release!: () => void;
      held.set(key, new Promise<void>((r) => (release = r)));
      return () => {
        held.delete(key);
        release();
      };
    },
  };
}

type SyncRun = {
  id: string;
  integrationId: string;
  kind: 'manual' | 'scheduled';
  status: string;
  triggeredBy?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  totals?: unknown;
  error?: string | null;
};

function harness(opts: {
  rows: MonitoredDomain[];
  cfDomains: CloudflareRegistrarDomain[];
  /** Resolved company id in config; '' = sync not configured. */
  companyId?: string;
  integrationId?: string;
  accountId?: string;
  locks?: ReturnType<typeof advisoryLocks>;
  runs?: SyncRun[];
}) {
  const integrationId = opts.integrationId ?? INT;
  const accountId = opts.accountId ?? 'acct';
  const companyId = opts.companyId ?? HODY;
  const locks = opts.locks ?? advisoryLocks();
  const rows = opts.rows;
  const runs: SyncRun[] = opts.runs ?? [];
  const matches = (r: object, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => {
      const actual = (r as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const op = v as { in?: unknown[]; lt?: Date };
        if (op.in) return op.in.includes(actual);
        if (op.lt) return actual instanceof Date && actual < op.lt;
      }
      return actual === v;
    });
  const tick = () => new Promise((r) => setImmediate(r));
  const monitoredDomain = {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      await tick();
      return rows.filter((r) => matches(r, where));
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    }),
    create: jest.fn(async ({ data }: { data: Partial<MonitoredDomain> }) => {
      await tick();
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
  };
  const integrationSyncRun = {
    create: jest.fn(async ({ data }: { data: Omit<SyncRun, 'id' | 'createdAt'> }) => {
      const r: SyncRun = { id: `run-${runs.length + 1}`, createdAt: new Date(), ...data };
      runs.push(r);
      return r;
    }),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const hits = runs.filter((r) => matches(r, where));
      return hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    }),
    findMany: jest.fn(async ({ where, skip }: { where: Record<string, unknown>; skip?: number }) =>
      runs
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(skip ?? 0),
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
      const hits = runs.filter((r) => matches(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    }),
    deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
      const before = runs.length;
      for (const id of where.id.in) runs.splice(runs.findIndex((r) => r.id === id), 1);
      return { count: before - runs.length };
    }),
  };
  const config = {
    accountId,
    ...(opts.companyId === '' ? {} : { domainsCompanyId: companyId }),
  };
  const prisma = {
    integration: {
      findUnique: jest.fn(async () => ({
        id: integrationId,
        driver: 'cloudflare',
        status: 'ACTIVE',
        config,
      })),
    },
    company: { findUnique: jest.fn(async () => ({ id: companyId, archivedAt: null })) },
    monitoredDomain,
    integrationSyncRun,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      const tx = {
        monitoredDomain,
        $executeRaw: jest.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => {
          releases.push(await locks.acquire(values.join('|')));
          return 1;
        }),
      };
      try {
        return await fn(tx);
      } finally {
        for (const release of releases) release();
      }
    }),
  };
  const integrations = {
    loadDriverContext: jest.fn(async () => ({ config, secret: { apiToken: 't' } })),
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
  const enqueueDomainCheck = jest.fn().mockResolvedValue('job-1');
  const queues = { get: jest.fn(() => ({ add })), enqueueDomainCheck };
  const svc = new CloudflareRegistrarSyncService(
    prisma as never,
    integrations as never,
    drivers as never,
    audit as never,
    env as never,
    redis as never,
    queues as never,
  );
  return { svc, rows, runs, audit, driver, kv, add, enqueueDomainCheck, prisma };
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

  it('adopts a Google Workspace-created row in the configured company (Cloudflare wins)', () => {
    const google = row({ id: 'g', source: 'GOOGLE_WORKSPACE', integrationId: 'int-google' });
    expect(m([google])).toEqual({ kind: 'adopt', row: google });
    expect(m([row({ source: 'GOOGLE_WORKSPACE', companyId: 'co-client' })]).kind).toBe('skip');
  });

  it('never takes another integration\'s row, and creates only when nothing exists', () => {
    expect(m([row({ source: 'CLOUDFLARE', integrationId: 'int-2' })]).kind).toBe('skip');
    expect(m([])).toEqual({ kind: 'create' });
  });
});

describe('CloudflareRegistrarSyncService.sync', () => {
  it('is a no-op when no domains company is configured', async () => {
    const { svc, driver, runs } = harness({ rows: [], cfDomains: [], companyId: '' });
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ enabled: false });
    expect(driver.listRegistrarDomains).not.toHaveBeenCalled();
    // A sweep with nothing to do leaves no run row behind.
    expect(runs).toHaveLength(0);
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

    expect(res).toEqual({ enabled: true, created: 1, updated: 1, adopted: 1, missing: 0, skipped: 0 });
    expect(moved.companyId).toBe('co-client');
    expect(manual).toMatchObject({ source: 'CLOUDFLARE', integrationId: INT, registrarAutoRenew: true });
    const created = rows.find((r) => r.hostname === 'new.example.org');
    expect(created).toMatchObject({ companyId: HODY, source: 'CLOUDFLARE', createdBy: 'u-1' });
  });

  it('queues a first check for each newly created domain, and only those', async () => {
    const existing = row({ id: 'old', hostname: 'old.com', source: 'CLOUDFLARE', integrationId: INT });
    const { svc, rows, enqueueDomainCheck } = harness({ rows: [existing], cfDomains: [cf('old.com'), cf('new.com')] });
    await svc.sync(INT, 'u-1');
    const created = rows.find((r) => r.hostname === 'new.com')!;
    expect(enqueueDomainCheck).toHaveBeenCalledTimes(1);
    expect(enqueueDomainCheck).toHaveBeenCalledWith({ kind: 'single', domainId: created.id, actorId: 'u-1' });
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
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ created: 0, updated: 0, skipped: 1 });
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

  it('records a scheduled run and its counts', async () => {
    const { svc, runs } = harness({ rows: [], cfDomains: [cf('a.com')] });
    await svc.sync(INT, null);
    expect(runs).toEqual([
      expect.objectContaining({
        kind: 'scheduled',
        status: 'succeeded',
        totals: expect.objectContaining({ created: 1 }),
      }),
    ]);
  });

  it('records and audits a Cloudflare failure with its reason, then rethrows', async () => {
    const { svc, runs, audit, rows, driver } = harness({ rows: [], cfDomains: [] });
    driver.listRegistrarDomains.mockRejectedValueOnce(
      new DriverAuthError('Cloudflare GET https://api.cloudflare.com/x returned 403: Authentication error'),
    );
    await expect(svc.sync(INT, 'u-1')).rejects.toThrow(/403/);
    expect(runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('403') });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0]).toMatchObject({
      action: 'integration.cloudflare.registrar_sync.failed',
      actorId: 'u-1',
      entityId: INT,
      after: {
        runId: runs[0]!.id,
        correlationId: expect.any(String),
        error: expect.stringContaining('Authentication error'),
      },
    });
    expect(rows).toHaveLength(0);
  });

  it('keeps internal error details out of the run row and the audit row', async () => {
    const { svc, runs, audit, prisma } = harness({ rows: [], cfDomains: [cf('a.com')] });
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const internal = 'Invalid `prisma.monitoredDomain.findMany()` invocation in /srv/app/dist/sync.js:42 relation "x" does not exist';
    prisma.$transaction.mockRejectedValueOnce(new Error(internal));

    await expect(svc.sync(INT, 'u-1')).rejects.toThrow(/does not exist/);

    const { correlationId, error } = audit.log.mock.calls[0][0].after;
    expect(error).toBe(`The domain sync failed because of an internal error. Reference: ${correlationId}`);
    expect(runs[0]!.error).toBe(error);
    expect(JSON.stringify(runs[0])).not.toMatch(/prisma|\/srv\//);
    // The details are in the server log, under the same id.
    expect(logged.mock.calls.flat().join(' ')).toMatch(
      new RegExp(`correlationId=${correlationId}.*does not exist`),
    );
    logged.mockRestore();
  });

  it('runs a manual request on its queued row', async () => {
    const runs: SyncRun[] = [
      { id: 'run-q', integrationId: INT, kind: 'manual', status: 'queued', createdAt: new Date() },
    ];
    const { svc } = harness({ rows: [], cfDomains: [cf('a.com')], runs });
    await svc.sync(INT, 'u-1', { runId: 'run-q' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', startedAt: expect.any(Date) });
  });

  it('fails a manual run that finds the lock taken, so the page does not wait forever', async () => {
    const runs: SyncRun[] = [
      { id: 'run-q', integrationId: INT, kind: 'manual', status: 'queued', createdAt: new Date() },
    ];
    const { svc, kv } = harness({ rows: [], cfDomains: [], runs });
    kv.set(`lock:cf-registrar-sync:${INT}`, 'sweep');
    await expect(svc.sync(INT, 'u-1', { runId: 'run-q' })).rejects.toThrow(/already running/);
    expect(runs[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/already running/) });
  });

  it('lets two integrations claim one new hostname only once, even when they run at the same time', async () => {
    const rows: MonitoredDomain[] = [];
    const locks = advisoryLocks();
    const a = harness({ rows, cfDomains: [cf('shared.com')], locks });
    const b = harness({
      rows,
      cfDomains: [cf('shared.com')],
      locks,
      integrationId: 'int-2',
      accountId: 'acct-2',
      companyId: '00000000-0000-4000-8000-0000000000bb',
    });
    const [ra, rb] = await Promise.all([a.svc.sync(INT, null), b.svc.sync('int-2', null)]);
    expect(rows.filter((r) => r.hostname === 'shared.com')).toHaveLength(1);
    expect(ra.created + rb.created).toBe(1);
  });
});

describe('CloudflareRegistrarSyncService.enqueue', () => {
  it('writes a queued run and queues a manual job carrying it and who asked', async () => {
    const { svc, add, runs } = harness({ rows: [], cfDomains: [] });
    const res = await svc.enqueue(INT, 'u-1');
    expect(runs).toEqual([
      expect.objectContaining({ kind: 'manual', status: 'queued', triggeredBy: 'u-1' }),
    ]);
    expect(res).toEqual({ queued: true, runId: runs[0]!.id });
    expect(add).toHaveBeenCalledWith(
      'manual',
      { integrationId: INT, triggeredBy: 'u-1', runId: runs[0]!.id },
      expect.objectContaining({ jobId: `manual-domains-${runs[0]!.id}` }),
    );
  });

  it('refuses up front while a sync holds the lock, instead of queueing a job that fails unseen', async () => {
    const { svc, add, kv } = harness({ rows: [], cfDomains: [] });
    kv.set(`lock:cf-registrar-sync:${INT}`, 'running');
    await expect(svc.enqueue(INT, 'u-1')).rejects.toThrow(/already running/);
    expect(add).not.toHaveBeenCalled();
  });

  it('refuses while a run is still queued', async () => {
    const runs: SyncRun[] = [
      { id: 'run-q', integrationId: INT, kind: 'manual', status: 'queued', createdAt: new Date() },
    ];
    const { svc, add } = harness({ rows: [], cfDomains: [], runs });
    await expect(svc.enqueue(INT, 'u-1')).rejects.toThrow(/already running/);
    expect(add).not.toHaveBeenCalled();
  });

  it('marks the run failed when the job cannot be queued', async () => {
    const { svc, add, runs } = harness({ rows: [], cfDomains: [] });
    add.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.enqueue(INT, 'u-1')).rejects.toThrow('redis down');
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'Could not queue the sync job.' });
  });

  it('settles a run abandoned by a dead worker so it no longer blocks', async () => {
    const runs: SyncRun[] = [
      {
        id: 'run-old',
        integrationId: INT,
        kind: 'manual',
        status: 'running',
        createdAt: new Date(Date.now() - 3 * 3_600_000),
      },
    ];
    const { svc, add } = harness({ rows: [], cfDomains: [], runs });
    await svc.enqueue(INT, 'u-1');
    expect(runs[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Interrupted/) });
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('CloudflareRegistrarSyncService.latestRun', () => {
  it('returns the newest run with its counts or error', async () => {
    const runs: SyncRun[] = [
      { id: 'r1', integrationId: INT, kind: 'scheduled', status: 'succeeded', createdAt: new Date(1000) },
      {
        id: 'r2',
        integrationId: INT,
        kind: 'manual',
        status: 'failed',
        createdAt: new Date(2000),
        error: 'boom',
      },
    ];
    const { svc } = harness({ rows: [], cfDomains: [], runs });
    await expect(svc.latestRun(INT)).resolves.toMatchObject({ id: 'r2', status: 'failed', error: 'boom' });
  });

  it('reports a run stuck past both leases as failed', async () => {
    const runs: SyncRun[] = [
      {
        id: 'r1',
        integrationId: INT,
        kind: 'manual',
        status: 'running',
        createdAt: new Date(Date.now() - 3 * 3_600_000),
      },
    ];
    const { svc } = harness({ rows: [], cfDomains: [], runs });
    await expect(svc.latestRun(INT)).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Interrupted/),
    });
  });
});
