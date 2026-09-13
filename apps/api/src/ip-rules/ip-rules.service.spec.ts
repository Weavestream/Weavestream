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

  it('coalesces one IPv6 /64 into one claim while auditing the exact address', async () => {
    const { svc, set, auditLog } = makeService();
    await svc.recordBlockedRequest({ ip: '2001:db8:1:2::5', cidr: '::/0' }, 'api');

    expect(set).toHaveBeenCalledWith(
      'secalert:ipblock:2001:db8:1:2::/64:::/0',
      '1',
      'EX',
      15 * 60,
      'NX',
    );
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ ip: '2001:db8:1:2::5' }));
  });
});

type RuleRow = { cidr: string; action: string; priority: number };

/**
 * `create` checks the post-change ruleset against the admin's own IP
 * before it writes anything, so these specs need only the enabled-rule
 * read and a `create` stub that the self-block guard must not reach.
 */
function makeRuleService(existing: RuleRow[]) {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'rule-new',
    note: null,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...data,
  }));
  const svc = new IpRulesService(
    { ipRule: { findMany: jest.fn().mockResolvedValue(existing), create } } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    { get: () => null, set: jest.fn(), invalidate: jest.fn() } as never,
    { client: { set: jest.fn().mockResolvedValue('OK') } } as never,
    { values: { LOCKOUT_MAX_FAILURES: 5, LOCKOUT_WINDOW_MIN: 15 } } as never,
  );
  return { svc, create };
}

const ADMIN = { id: 'admin-1' } as never;

function deny(cidr: string, priority = 10) {
  return { cidr, action: 'DENY' as const, priority, note: null, enabled: true };
}

function from(ip: string) {
  return { ip, userAgent: 'SpecUA/1.0' };
}

describe('IpRulesService self-block guard (IPv6 admins)', () => {
  it('refuses a DENY whose IPv6 CIDR covers the admin', async () => {
    const { svc, create } = makeRuleService([]);
    await expect(svc.create(ADMIN, deny('2001:db8::/32'), from('2001:db8:1:2::5'))).rejects.toThrow(
      /would block your current IP \(2001:db8:1:2::5\)/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses DENY ::/0 from an IPv6 admin', async () => {
    const { svc, create } = makeRuleService([]);
    await expect(svc.create(ADMIN, deny('::/0'), from('2606:4700::1'))).rejects.toThrow(
      /would block your current IP/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('allows the DENY once a higher-priority ALLOW covers the admin', async () => {
    const { svc, create } = makeRuleService([
      { cidr: '2001:db8:1:2::5', action: 'ALLOW', priority: 1 },
    ]);
    await expect(svc.create(ADMIN, deny('::/0'), from('2001:db8:1:2::5'))).resolves.toMatchObject({
      cidr: '::/0',
      action: 'DENY',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not count an IPv4 catch-all as blocking an IPv6 admin', async () => {
    const { svc, create } = makeRuleService([]);
    await expect(svc.create(ADMIN, deny('0.0.0.0/0'), from('2001:db8::5'))).resolves.toMatchObject({
      cidr: '0.0.0.0/0',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('still refuses an IPv4 DENY that covers an IPv4-mapped admin', async () => {
    const { svc, create } = makeRuleService([]);
    await expect(svc.create(ADMIN, deny('192.0.2.0/24'), from('::ffff:192.0.2.7'))).rejects.toThrow(
      /would block your current IP/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('IpRulesService.catchAllFamilyGap', () => {
  it('reports an IPv4 DENY catch-all with no IPv6 counterpart', async () => {
    const { svc } = makeRuleService([
      { cidr: '203.0.113.0/24', action: 'ALLOW', priority: 1 },
      { cidr: '0.0.0.0/0', action: 'DENY', priority: 10 },
    ]);
    await expect(svc.catchAllFamilyGap()).resolves.toEqual({
      family: 'IPv4',
      uncoveredFamily: 'IPv6',
      cidr: '0.0.0.0/0',
    });
  });

  it('reports nothing once ::/0 is also denied', async () => {
    const { svc } = makeRuleService([
      { cidr: '0.0.0.0/0', action: 'DENY', priority: 10 },
      { cidr: '::/0', action: 'DENY', priority: 11 },
    ]);
    await expect(svc.catchAllFamilyGap()).resolves.toBeNull();
  });
});
