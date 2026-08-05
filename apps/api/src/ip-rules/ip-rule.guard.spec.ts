import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { IpRuleGuard } from './ip-rule.guard.js';
import { IpRuleCacheService } from './ip-rule-cache.service.js';
import type { IpRulesService } from './ip-rules.service.js';

type Rule = { cidr: string; action: string; priority: number };

function ctxFor(ip: string): ExecutionContext {
  const req = {
    ip,
    headers: { 'user-agent': 'GuardSpec/1.0' },
    originalUrl: '/api/v1/companies?page=2',
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(loadEnabledRules: () => Promise<Rule[]>): {
  guard: IpRuleGuard;
  service: { loadEnabledRules: jest.Mock; recordBlockedRequest: jest.Mock };
  cache: IpRuleCacheService;
} {
  const service = {
    loadEnabledRules: jest.fn(loadEnabledRules),
    recordBlockedRequest: jest.fn().mockResolvedValue(undefined),
  };
  const cache = new IpRuleCacheService();
  const guard = new IpRuleGuard(service as unknown as IpRulesService, cache);
  return { guard, service, cache };
}

describe('IpRuleGuard', () => {
  it('allows when no rules exist', async () => {
    const { guard } = makeGuard(async () => []);
    await expect(guard.canActivate(ctxFor('203.0.113.5'))).resolves.toBe(true);
  });

  it('fails open if loading rules throws (e.g. table missing, DB down)', async () => {
    const { guard } = makeGuard(async () => {
      throw new Error('relation "ip_rules" does not exist');
    });
    await expect(guard.canActivate(ctxFor('203.0.113.5'))).resolves.toBe(true);
  });

  it('throws ForbiddenException for matching DENY rule', async () => {
    const { guard } = makeGuard(async () => [
      { cidr: '203.0.113.0/24', action: 'DENY', priority: 10 },
    ]);
    await expect(guard.canActivate(ctxFor('203.0.113.5'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows for matching ALLOW rule', async () => {
    const { guard } = makeGuard(async () => [
      { cidr: '10.0.0.0/8', action: 'ALLOW', priority: 5 },
    ]);
    await expect(guard.canActivate(ctxFor('10.1.2.3'))).resolves.toBe(true);
  });

  it('first matching rule wins (priority order)', async () => {
    // Lower priority value = evaluated first. ALLOW at priority 1 should
    // beat DENY at priority 10 even though both match.
    const { guard } = makeGuard(async () => [
      { cidr: '10.0.0.0/8', action: 'ALLOW', priority: 1 },
      { cidr: '10.0.0.0/8', action: 'DENY', priority: 10 },
    ]);
    await expect(guard.canActivate(ctxFor('10.1.2.3'))).resolves.toBe(true);
  });

  it('default-allows when no rule matches', async () => {
    const { guard } = makeGuard(async () => [
      { cidr: '10.0.0.0/8', action: 'DENY', priority: 1 },
    ]);
    await expect(guard.canActivate(ctxFor('203.0.113.5'))).resolves.toBe(true);
  });

  it('matches a single-IP rule (no /)', async () => {
    const { guard } = makeGuard(async () => [
      { cidr: '198.51.100.7', action: 'DENY', priority: 1 },
    ]);
    await expect(guard.canActivate(ctxFor('198.51.100.7'))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(guard.canActivate(ctxFor('198.51.100.8'))).resolves.toBe(true);
  });

  it('caches loaded rules across requests', async () => {
    const { guard, service } = makeGuard(async () => [
      { cidr: '10.0.0.0/8', action: 'ALLOW', priority: 1 },
    ]);
    await guard.canActivate(ctxFor('10.0.0.1'));
    await guard.canActivate(ctxFor('10.0.0.2'));
    await guard.canActivate(ctxFor('10.0.0.3'));
    expect(service.loadEnabledRules).toHaveBeenCalledTimes(1);
  });

  it('cache.invalidate() forces a reload on next request', async () => {
    const { guard, service, cache } = makeGuard(async () => [
      { cidr: '10.0.0.0/8', action: 'ALLOW', priority: 1 },
    ]);
    await guard.canActivate(ctxFor('10.0.0.1'));
    expect(service.loadEnabledRules).toHaveBeenCalledTimes(1);

    cache.invalidate();
    await guard.canActivate(ctxFor('10.0.0.2'));
    expect(service.loadEnabledRules).toHaveBeenCalledTimes(2);
  });

  it('matches IPv4-mapped IPv6 against plain IPv4 CIDR rules', async () => {
    // Reproduces the user-reported case: phone connects via dual-stack,
    // Express sets req.ip to "::ffff:192.168.1.50", admin adds a deny
    // rule for "192.168.1.50/32" — must still fire.
    const { guard } = makeGuard(async () => [
      { cidr: '192.168.1.50/32', action: 'DENY', priority: 1 },
    ]);
    await expect(guard.canActivate(ctxFor('::ffff:192.168.1.50'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('treats missing req.ip as 0.0.0.0', async () => {
    const { guard } = makeGuard(async () => [
      { cidr: '0.0.0.0/32', action: 'DENY', priority: 1 },
    ]);
    const noIpCtx = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(noIpCtx)).rejects.toThrow(ForbiddenException);
  });

  it('rejects malformed CIDR safely (no match, default allow)', async () => {
    const { guard } = makeGuard(async () => [
      { cidr: 'not-an-ip', action: 'DENY', priority: 1 },
      { cidr: '10.0.0.0/40', action: 'DENY', priority: 2 },
    ]);
    await expect(guard.canActivate(ctxFor('10.0.0.1'))).resolves.toBe(true);
  });

  // ── security.ip_rule.blocked reporting (detached, best-effort) ──────

  it('reports a DENY to recordBlockedRequest (source api) and still throws 403', async () => {
    const { guard, service } = makeGuard(async () => [
      { cidr: '203.0.113.0/24', action: 'DENY', priority: 7 },
    ]);
    await expect(guard.canActivate(ctxFor('203.0.113.5'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(service.recordBlockedRequest).toHaveBeenCalledTimes(1);
    expect(service.recordBlockedRequest).toHaveBeenCalledWith(
      {
        ip: '203.0.113.5',
        cidr: '203.0.113.0/24',
        priority: 7,
        path: '/api/v1/companies?page=2',
        userAgent: 'GuardSpec/1.0',
      },
      'api',
    );
  });

  it('passes the normalized IP to the report (IPv4-mapped IPv6)', async () => {
    const { guard, service } = makeGuard(async () => [
      { cidr: '192.168.1.50/32', action: 'DENY', priority: 1 },
    ]);
    await expect(
      guard.canActivate(ctxFor('::ffff:192.168.1.50')),
    ).rejects.toThrow(ForbiddenException);
    expect(service.recordBlockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '192.168.1.50' }),
      'api',
    );
  });

  it('does not report ALLOW matches or non-matches', async () => {
    const { guard, service } = makeGuard(async () => [
      { cidr: '10.0.0.0/8', action: 'ALLOW', priority: 1 },
    ]);
    await guard.canActivate(ctxFor('10.1.2.3'));
    await guard.canActivate(ctxFor('203.0.113.5'));
    expect(service.recordBlockedRequest).not.toHaveBeenCalled();
  });

  it('a rejecting report never changes the 403 (detached best-effort)', async () => {
    const { guard, service } = makeGuard(async () => [
      { cidr: '203.0.113.0/24', action: 'DENY', priority: 1 },
    ]);
    service.recordBlockedRequest.mockRejectedValue(new Error('audit db down'));
    await expect(guard.canActivate(ctxFor('203.0.113.5'))).rejects.toThrow(
      ForbiddenException,
    );
    // Flush the detached promise chain so an unhandled rejection would
    // surface here if the guard forgot its .catch.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
