import { IpRulesService } from './ip-rules.service.js';

/**
 * `recordBlockedRequest` — the single boundary through which both
 * enforcement layers (API guard, web-proxy report) write
 * `security.ip_rule.blocked` audit rows. Asserts the properties the
 * callers rely on: claimOnce coalescing, length clamps applied HERE
 * (callers pass attacker-controlled values through), awaited audit
 * durability, and fail-quiet Redis degradation.
 */

function makeService({
  setResult = 'OK' as string | null,
  setRejects = false,
  auditLog = jest.fn().mockResolvedValue(undefined),
} = {}) {
  const set = setRejects
    ? jest.fn().mockRejectedValue(new Error('redis down'))
    : jest.fn().mockResolvedValue(setResult);
  const env = { values: { LOCKOUT_MAX_FAILURES: 5, LOCKOUT_WINDOW_MIN: 15 } };
  const svc = new IpRulesService(
    {} as never, // prisma — unused by recordBlockedRequest
    { log: auditLog } as never,
    {} as never, // cache — unused
    { client: { set } } as never,
    env as never,
  );
  return { svc, set, auditLog };
}

describe('IpRulesService.recordBlockedRequest', () => {
  it('claims one window per (ip, cidr) with the lockout-window TTL, then audits', async () => {
    const { svc, set, auditLog } = makeService();
    await svc.recordBlockedRequest(
      {
        ip: '203.0.113.5',
        cidr: '203.0.113.0/24',
        priority: 7,
        path: '/admin?tab=users',
        userAgent: 'UA/1.0',
      },
      'api',
    );

    expect(set).toHaveBeenCalledWith(
      'secalert:ipblock:203.0.113.5:203.0.113.0/24',
      '1',
      'EX',
      15 * 60,
      'NX',
    );
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith({
      actorId: null,
      action: 'security.ip_rule.blocked',
      entityType: 'IpRule',
      entityId: null,
      ip: '203.0.113.5',
      userAgent: 'UA/1.0',
      before: null,
      after: {
        cidr: '203.0.113.0/24',
        priority: 7,
        source: 'api',
        path: '/admin', // query string stripped
      },
    });
  });

  it('skips the audit write when the window is already claimed', async () => {
    const { svc, auditLog } = makeService({ setResult: null });
    await svc.recordBlockedRequest({ ip: '1.2.3.4', cidr: '1.2.3.0/24' }, 'web');
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('fails quiet (no audit, no throw) when Redis is down', async () => {
    const { svc, auditLog } = makeService({ setRejects: true });
    await expect(
      svc.recordBlockedRequest({ ip: '1.2.3.4', cidr: '1.2.3.0/24' }, 'api'),
    ).resolves.toBeUndefined();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('clamps attacker-controlled fields at this boundary (ip/cidr 64, path/UA 500)', async () => {
    const { svc, auditLog } = makeService();
    await svc.recordBlockedRequest(
      {
        ip: 'x'.repeat(100),
        cidr: 'c'.repeat(100),
        path: `/${'p'.repeat(700)}?q=1`,
        userAgent: 'u'.repeat(700),
      },
      'web',
    );

    expect(auditLog).toHaveBeenCalledTimes(1);
    const entry = auditLog.mock.calls[0]?.[0] as {
      ip: string;
      userAgent: string;
      after: { cidr: string; path: string; source: string };
    };
    expect(entry.ip).toHaveLength(64);
    expect(entry.userAgent).toHaveLength(500);
    expect(entry.after.cidr).toHaveLength(64);
    expect(entry.after.path.length).toBeLessThanOrEqual(500);
    expect(entry.after.path).not.toContain('?');
    expect(entry.after.source).toBe('web');
  });

  it('resolves only after the audit write is durable (the 204 must mean it)', async () => {
    let resolveAudit: (() => void) | undefined;
    const auditLog = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAudit = resolve;
        }),
    );
    const { svc } = makeService({ auditLog });

    let settled = false;
    const pending = svc
      .recordBlockedRequest({ ip: '1.2.3.4', cidr: '1.2.3.0/24' }, 'web')
      .then(() => {
        settled = true;
      });

    await new Promise((resolve) => setImmediate(resolve));
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); // still pending until the row is durable

    resolveAudit?.();
    await pending;
    expect(settled).toBe(true);
  });
});
