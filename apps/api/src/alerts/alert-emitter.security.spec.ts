import { alertsSendJobSchema } from '@weavestream/shared';
import { AlertEmitterService } from './alert-emitter.service.js';
import type { PersistedAuditEntry } from '../audit/audit.service.js';

/**
 * Security-alert matching in AlertEmitterService: reserved-selector
 * configs, threshold vs immediate firing, partition against the CRUD
 * path, dedup keys, and the email-content allowlist (canary secrets in
 * audit payloads must never render).
 */

interface ConfigRow {
  id: string;
  name: string;
  type: 'RECORD_EVENT' | 'PASSWORD_EVENT';
  companyId: string | null;
  recipientEmails: string[];
  recordEntityTypes: string[];
  recordActions: string[];
}

function configRow(over: Partial<ConfigRow> & { id: string }): ConfigRow {
  return {
    name: `cfg ${over.id}`,
    type: 'RECORD_EVENT',
    companyId: null,
    recipientEmails: ['sec@example.com'],
    recordEntityTypes: ['security:sign-in-failures'],
    recordActions: ['all'],
    ...over,
  };
}

function entryOf(
  action: string,
  over: Partial<PersistedAuditEntry> = {},
): PersistedAuditEntry {
  return {
    id: 'evt-1',
    actorId: null,
    action,
    entityType: 'User',
    entityId: null,
    companyId: null,
    ip: '203.0.113.9',
    userAgent: 'TestAgent/1.0',
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
    before: null,
    after: null,
    ...over,
  };
}

function makeEmitter(rows: ConfigRow[]) {
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const queueAdd = jest.fn().mockResolvedValue(undefined);
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = {
    alertConfig: { findMany },
    alertTrigger: { createMany },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: 'Ada Operator', email: 'ada@example.com' }),
    },
    asset: { findUnique: jest.fn().mockResolvedValue(null) },
    article: { findUnique: jest.fn().mockResolvedValue(null) },
    password: { findUnique: jest.fn().mockResolvedValue(null) },
    monitoredDomain: { findUnique: jest.fn().mockResolvedValue(null) },
    company: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const audit = { registerHook: jest.fn() };
  const queues = { get: jest.fn(() => ({ add: queueAdd })) };
  const env = { values: { LOCKOUT_MAX_FAILURES: 5, LOCKOUT_WINDOW_MIN: 15 } };
  const svc = new AlertEmitterService(
    prisma as never,
    audit as never,
    queues as never,
    env as never,
  );
  return { svc, createMany, queueAdd, findMany };
}

async function primed(rows: ConfigRow[]) {
  const ctx = makeEmitter(rows);
  await ctx.svc.invalidate(); // loads the mocked findMany rows into the cache
  return ctx;
}

// Real UUIDs — the enqueue payload is validated against
// `alertsSendJobSchema`, whose `alertConfigId` is `z.string().uuid()`.
const SIGNIN_ID = '00000000-0000-4000-8000-000000000001';
const IPBLOCK_ID = '00000000-0000-4000-8000-000000000002';
const SUSPICIOUS_ID = '00000000-0000-4000-8000-000000000003';
const CRUD_ALL_ID = '00000000-0000-4000-8000-000000000004';

const SIGNIN_CFG = configRow({ id: SIGNIN_ID, name: 'Signin watch' });
const IPBLOCK_CFG = configRow({
  id: IPBLOCK_ID,
  name: 'Block watch',
  recordEntityTypes: ['security:ip-blocked'],
});
const SUSPICIOUS_CFG = configRow({
  id: SUSPICIOUS_ID,
  name: 'Suspicious watch',
  recordEntityTypes: ['security:suspicious-activity'],
});
const CRUD_ALL_CFG = configRow({
  id: CRUD_ALL_ID,
  name: 'All records',
  recordEntityTypes: ['all'],
  recordActions: ['all'],
});

describe('AlertEmitterService — security matching', () => {
  it('loads only enabled, non-archived RECORD_EVENT/PASSWORD_EVENT configs (disabled never fire)', async () => {
    const { findMany } = await primed([SIGNIN_CFG]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archivedAt: null,
          enabled: true,
          type: { in: ['RECORD_EVENT', 'PASSWORD_EVENT'] },
        }),
      }),
    );
  });

  it('fires sign-in-failures exactly when a counter REACHES the threshold', async () => {
    const { svc, queueAdd } = await primed([SIGNIN_CFG]);

    await svc.maybeFire(
      entryOf('auth.login.failure', {
        after: {
          attemptedEmail: 'victim@example.com',
          failureCounts: { ip: 5, email: 2 },
        },
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const payload = queueAdd.mock.calls[0]?.[1] as { subject: string; text: string };
    expect(payload.subject).toBe(
      '[Weavestream] Security — Repeated failed sign-ins — Signin watch',
    );
    expect(payload.text).toContain('victim@example.com');
    expect(payload.text).toContain('203.0.113.9');
    expect(payload.text).toContain('Failures from this IP: 5 within 15 min');
    expect(payload.text).toContain('Audit event id: evt-1');
  });

  it('fires on the email counter crossing even when the IP counter is low', async () => {
    const { svc, queueAdd } = await primed([SIGNIN_CFG]);
    await svc.maybeFire(
      entryOf('auth.login.failure', {
        after: { attemptedEmail: 'v@example.com', failureCounts: { ip: 1, email: 5 } },
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('stays silent below the threshold and when counts are absent (Redis degraded)', async () => {
    const { svc, queueAdd } = await primed([SIGNIN_CFG, IPBLOCK_CFG]);

    await svc.maybeFire(
      entryOf('auth.login.failure', {
        after: { attemptedEmail: 'v@example.com', failureCounts: { ip: 4, email: 4 } },
      }),
    );
    await svc.maybeFire(
      entryOf('auth.login.failure', {
        after: { attemptedEmail: 'v@example.com', failureCounts: null },
      }),
    );
    await svc.maybeFire(
      entryOf('auth.login.failure', { after: { attemptedEmail: 'v@example.com' } }),
    );
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('fans the threshold-crossing login failure out to ip-blocked configs too (soft-lock reached)', async () => {
    const { svc, queueAdd } = await primed([SIGNIN_CFG, IPBLOCK_CFG]);
    await svc.maybeFire(
      entryOf('auth.login.failure', {
        after: { attemptedEmail: 'v@example.com', failureCounts: { ip: 5, email: 5 } },
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(2);
    const configIds = queueAdd.mock.calls.map(
      (c) => (c[1] as { alertConfigId: string }).alertConfigId,
    );
    expect(configIds.sort()).toEqual([SIGNIN_ID, IPBLOCK_ID].sort());
  });

  it('fires ip-blocked immediately on ip_rule.blocked and ratelimit.blocked events', async () => {
    const { svc, queueAdd } = await primed([IPBLOCK_CFG]);

    await svc.maybeFire(
      entryOf('security.ip_rule.blocked', {
        id: 'evt-a',
        after: { cidr: '203.0.113.0/24', priority: 3, source: 'web', path: '/login' },
      }),
    );
    await svc.maybeFire(
      entryOf('security.ratelimit.blocked', {
        id: 'evt-b',
        after: {
          limiter: 'auth',
          limit: 5,
          windowSec: 60,
          route: '/api/v1/auth/login',
          method: 'POST',
          retryAfterSec: 42,
          attemptedEmail: 'v@example.com',
        },
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(2);
    const first = queueAdd.mock.calls[0]?.[1] as { text: string };
    expect(first.text).toContain('Matched rule: 203.0.113.0/24');
    expect(first.text).toContain('web page layer');
    const second = queueAdd.mock.calls[1]?.[1] as { text: string };
    expect(second.text).toContain('Limit:   5 requests per 60s');
    expect(second.text).toContain('Retry allowed in: 42s');
  });

  it('partition: an "all record types" CRUD config never fires on security events', async () => {
    const { svc, queueAdd } = await primed([CRUD_ALL_CFG]);
    await svc.maybeFire(
      entryOf('auth.login.failure', {
        after: { attemptedEmail: 'v@example.com', failureCounts: { ip: 5, email: 5 } },
      }),
    );
    await svc.maybeFire(entryOf('security.ip_rule.blocked', { after: { cidr: 'x' } }));
    await svc.maybeFire(entryOf('auth.refresh.reused', { actorId: 'u-1' }));
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('partition: a security config never fires on CRUD events', async () => {
    const { svc, queueAdd } = await primed([SIGNIN_CFG, SUSPICIOUS_CFG]);
    await svc.maybeFire(
      entryOf('asset.create', {
        entityType: 'Asset',
        entityId: 'a-1',
        companyId: 'co-1',
      }),
    );
    await svc.maybeFire(entryOf('password.update', { entityType: 'Password' }));
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('suspicious-activity: immediate events fire once per audit row (trigger-key dedup)', async () => {
    const { svc, queueAdd, createMany } = await primed([SUSPICIOUS_CFG]);
    createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const reuse = entryOf('auth.refresh.reused', {
      actorId: 'u-1',
      after: { reason: 'rotated_token_reused', tokenHashPrefix: 'abc123def456' },
    });
    await svc.maybeFire(reuse);
    await svc.maybeFire(reuse); // replayed hook — trigger row already exists
    expect(createMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: [
          {
            alertConfigId: SUSPICIOUS_ID,
            key: `audit:evt-1:${SUSPICIOUS_ID}`,
          },
        ],
        skipDuplicates: true,
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('suspicious-activity: step-up anomaly dedups per user per UTC day', async () => {
    const { svc, createMany } = await primed([SUSPICIOUS_CFG]);
    await svc.maybeFire(
      entryOf('security.stepup.anomaly', {
        actorId: 'u-9',
        after: { reason: 'mfa_enabled_without_secret' },
      }),
    );
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { alertConfigId: SUSPICIOUS_ID, key: 'sec:anomaly:u-9:2026-08-04' },
        ],
      }),
    );
  });

  it('suspicious-activity: threshold kinds fire at the threshold, not below', async () => {
    const { svc, queueAdd } = await primed([SUSPICIOUS_CFG]);

    await svc.maybeFire(
      entryOf('auth.mfa.verify.failure', { actorId: 'u-1', after: { failureCount: 4 } }),
    );
    expect(queueAdd).not.toHaveBeenCalled();

    await svc.maybeFire(
      entryOf('auth.mfa.verify.failure', { actorId: 'u-1', after: { failureCount: 5 } }),
    );
    await svc.maybeFire(
      entryOf('security.stepup.failed', {
        actorId: 'u-1',
        after: { factor: 'mfa', sessionId: 'sess-canary-1', failureCount: 5 },
      }),
    );
    await svc.maybeFire(
      entryOf('user.password.change.failed', {
        actorId: 'u-1',
        after: { sessionId: 'sess-canary-2', failureCount: 5 },
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(3);
  });

  it('content allowlist: canary values in audit payloads never reach subject or text', async () => {
    const { svc, queueAdd } = await primed([SIGNIN_CFG, IPBLOCK_CFG, SUSPICIOUS_CFG]);

    await svc.maybeFire(
      entryOf('auth.refresh.reused', {
        actorId: 'u-1',
        after: {
          reason: 'rotated_token_reused',
          tokenHashPrefix: 'CANARY_HASH_PREFIX',
        },
      }),
    );
    await svc.maybeFire(
      entryOf('security.stepup.failed', {
        id: 'evt-2',
        actorId: 'u-1',
        after: { factor: 'mfa', sessionId: 'CANARY_SESSION_ID', failureCount: 5 },
      }),
    );
    await svc.maybeFire(
      entryOf('auth.login.failure', {
        id: 'evt-3',
        after: {
          attemptedEmail: 'v@example.com',
          failureCounts: { ip: 5, email: 1 },
          password: 'CANARY_PASSWORD',
          secretBlob: { token: 'CANARY_TOKEN' },
        },
      }),
    );

    expect(queueAdd.mock.calls.length).toBeGreaterThan(0);
    for (const call of queueAdd.mock.calls) {
      const payload = call[1] as { subject: string; text: string };
      const rendered = `${payload.subject}\n${payload.text}`;
      expect(rendered).not.toContain('CANARY_HASH_PREFIX');
      expect(rendered).not.toContain('CANARY_SESSION_ID');
      expect(rendered).not.toContain('CANARY_PASSWORD');
      expect(rendered).not.toContain('CANARY_TOKEN');
    }
  });

  it('every enqueued security job conforms to alertsSendJobSchema', async () => {
    const { svc, queueAdd } = await primed([SIGNIN_CFG, IPBLOCK_CFG, SUSPICIOUS_CFG]);

    await svc.maybeFire(
      entryOf('auth.login.failure', {
        after: {
          attemptedEmail: `${'x'.repeat(400)}@example.com`,
          failureCounts: { ip: 5, email: 5 },
        },
      }),
    );
    await svc.maybeFire(
      entryOf('security.ip_rule.blocked', {
        id: 'evt-4',
        after: { cidr: '10.0.0.0/8', priority: 0, source: 'api', path: '/x' },
      }),
    );

    expect(queueAdd.mock.calls.length).toBeGreaterThan(0);
    for (const call of queueAdd.mock.calls) {
      const parsed = alertsSendJobSchema.safeParse(call[1]);
      expect(parsed.success).toBe(true);
    }
  });
});
