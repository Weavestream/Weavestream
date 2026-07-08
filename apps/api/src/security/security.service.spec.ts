import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { SecurityService } from './security.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Minimal Express-request stub with the surface `connectionDiagnostics`
 * touches: `ip` (already-resolved by Express `trust proxy`), the socket
 * peer, and the two forwarding headers.
 */
function makeReq(args: {
  ip: string;
  peer?: string;
  xff?: string;
  inboundXff?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (args.xff !== undefined) headers['x-forwarded-for'] = args.xff;
  if (args.inboundXff !== undefined) headers['x-ws-inbound-xff'] = args.inboundXff;
  return {
    ip: args.ip,
    socket: { remoteAddress: args.peer ?? args.ip },
    headers,
  } as unknown as Request;
}

type AuditCall = Parameters<{ log: (e: unknown) => Promise<void> }['log']>[0];

const ADMIN: AuthedUser = {
  id: 'admin',
  email: 'admin@example.com',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
  sessionId: 's-admin',
  mfaEnforcementCompletedAt: new Date(0),
  mfaPending: false,
};

function makeService(args: {
  auditRows?: Array<{
    id: string;
    action: string;
    ip: string | null;
    userAgent: string | null;
    createdAt: Date;
    actorId: string | null;
    actor: { id: string; name: string; email: string } | null;
    after: unknown;
  }>;
  sessionRows?: Array<Record<string, unknown>>;
  redisStore?: Map<string, { value: string; ttl: number; pttl: number }>;
  envValues?: {
    LOCKOUT_MAX_FAILURES?: number;
    LOCKOUT_WINDOW_MIN?: number;
    TRUST_PROXY_HOPS?: number;
    APP_URL?: string;
    NODE_ENV?: string;
  };
  sessionUpdate?: jest.Mock;
  sessionFindUnique?: jest.Mock;
}) {
  const audit: Array<AuditCall> = [];
  const store = args.redisStore ?? new Map();

  // SCAN cursor 0 → return everything matching pattern in one call.
  const scan = jest
    .fn()
    .mockImplementation(
      async (_cursor: string, _match: string, pattern: string, _count: string, _n: number) => {
        // ioredis call signature is (cursor, 'MATCH', pattern, 'COUNT', n);
        // we collapse to a single pass for the mock.
        const all = Array.from(store.keys());
        const re = new RegExp(
          '^' + pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*') + '$',
        );
        return ['0', all.filter((k) => re.test(k))];
      },
    );

  // The service uses positional `client.scan(cursor, 'MATCH', ...)`,
  // ioredis accepts that variant and forwards to the same handler.
  const pipeline = () => {
    const ops: Array<{ cmd: 'get' | 'ttl' | 'pttl'; key: string }> = [];
    return {
      get(key: string) {
        ops.push({ cmd: 'get', key });
        return this;
      },
      ttl(key: string) {
        ops.push({ cmd: 'ttl', key });
        return this;
      },
      pttl(key: string) {
        ops.push({ cmd: 'pttl', key });
        return this;
      },
      async exec() {
        return ops.map((o) => {
          const r = store.get(o.key);
          if (!r) return [null, null];
          if (o.cmd === 'get') return [null, r.value];
          if (o.cmd === 'ttl') return [null, r.ttl];
          return [null, r.pttl];
        });
      },
    };
  };

  const redis = {
    client: {
      scan: jest
        .fn()
        .mockImplementation(
          async (
            _cursor: string,
            _matchTok: string,
            pattern: string,
          ) => scan('0', 'MATCH', pattern, 'COUNT', 200),
        ),
      pipeline,
    },
  };

  const prisma = {
    auditLog: {
      findMany: jest.fn().mockResolvedValue(args.auditRows ?? []),
    },
    session: {
      findMany: jest.fn().mockResolvedValue(args.sessionRows ?? []),
      findUnique:
        args.sessionFindUnique ??
        jest.fn().mockResolvedValue(null),
      update: args.sessionUpdate ?? jest.fn().mockResolvedValue(undefined),
    },
  };

  const env = {
    values: {
      LOCKOUT_MAX_FAILURES: args.envValues?.LOCKOUT_MAX_FAILURES ?? 5,
      LOCKOUT_WINDOW_MIN: args.envValues?.LOCKOUT_WINDOW_MIN ?? 15,
      TRUST_PROXY_HOPS: args.envValues?.TRUST_PROXY_HOPS ?? 1,
      APP_URL: args.envValues?.APP_URL ?? 'http://localhost:3000',
      NODE_ENV: args.envValues?.NODE_ENV ?? 'test',
    },
  };

  const auditService = {
    log: async (e: AuditCall) => {
      audit.push(e);
    },
  };

  // Cast through unknown — these mocks intentionally duck-type the
  // shape the service actually uses without re-declaring the full
  // Prisma / Redis surfaces.
  const stepUp = { clear: jest.fn().mockResolvedValue(undefined) };
  const service = new SecurityService(
    prisma as unknown as ConstructorParameters<typeof SecurityService>[0],
    redis as unknown as ConstructorParameters<typeof SecurityService>[1],
    env as unknown as ConstructorParameters<typeof SecurityService>[2],
    auditService as unknown as ConstructorParameters<typeof SecurityService>[3],
    stepUp as unknown as ConstructorParameters<typeof SecurityService>[4],
  );
  return { service, prisma, audit };
}

describe('SecurityService.loginActivity', () => {
  it('aggregates by ip and email and counts success vs failure', async () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const { service } = makeService({
      auditRows: [
        {
          id: 'a1',
          action: 'auth.login.failure',
          ip: '1.2.3.4',
          userAgent: 'Chrome',
          createdAt: now,
          actorId: null,
          actor: null,
          after: { attemptedEmail: 'alice@example.com' },
        },
        {
          id: 'a2',
          action: 'auth.login.failure',
          ip: '1.2.3.4',
          userAgent: 'Chrome',
          createdAt: now,
          actorId: null,
          actor: null,
          after: { attemptedEmail: 'alice@example.com' },
        },
        {
          id: 'a3',
          action: 'auth.login.success',
          ip: '5.6.7.8',
          userAgent: 'Firefox',
          createdAt: now,
          actorId: 'u1',
          actor: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
          after: null,
        },
        {
          id: 'a4',
          action: 'auth.mfa.verify.failure',
          ip: '9.9.9.9',
          userAgent: null,
          createdAt: now,
          actorId: 'u2',
          actor: { id: 'u2', name: 'Bob', email: 'bob@example.com' },
          after: null,
        },
      ],
    });

    const out = await service.loginActivity(24);

    expect(out.windowHours).toBe(24);
    expect(out.counts).toEqual({ success: 1, failure: 2, mfaFailure: 1 });
    expect(out.byIp).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: '1.2.3.4',
          success: 0,
          failure: 2,
        }),
        expect.objectContaining({
          identifier: '5.6.7.8',
          success: 1,
          failure: 0,
        }),
        expect.objectContaining({
          identifier: '9.9.9.9',
          success: 0,
          failure: 1,
        }),
      ]),
    );
    expect(out.byEmail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: 'alice@example.com',
          // Two failures + one success roll up under the same email
          // because the success row also carries `alice@example.com`.
          failure: 2,
          success: 1,
        }),
      ]),
    );
    expect(out.recent[0]?.id).toBe('a1');
  });

  it('clamps the window to the [1, 168] hour range', async () => {
    const { service } = makeService({});
    const out = await service.loginActivity(99999);
    expect(out.windowHours).toBe(168);
    const out2 = await service.loginActivity(0);
    expect(out2.windowHours).toBe(1);
  });
});

describe('SecurityService.activeLockouts', () => {
  it('lists ip and email lockouts with TTL and locked flag', async () => {
    const store = new Map<
      string,
      { value: string; ttl: number; pttl: number }
    >();
    store.set('login:fail:ip:1.2.3.4', { value: '7', ttl: 600, pttl: 600_000 });
    store.set('login:fail:ip:5.6.7.8', { value: '2', ttl: 60, pttl: 60_000 });
    store.set('login:fail:email:alice@example.com', {
      value: '5',
      ttl: 300,
      pttl: 300_000,
    });

    const { service } = makeService({
      redisStore: store,
      envValues: { LOCKOUT_MAX_FAILURES: 5, LOCKOUT_WINDOW_MIN: 15 },
    });

    const out = await service.activeLockouts();
    expect(out.threshold).toBe(5);
    expect(out.windowMinutes).toBe(15);
    expect(out.ip).toEqual([
      expect.objectContaining({
        identifier: '1.2.3.4',
        failures: 7,
        locked: true,
      }),
      expect.objectContaining({
        identifier: '5.6.7.8',
        failures: 2,
        locked: false,
      }),
    ]);
    expect(out.email).toEqual([
      expect.objectContaining({
        identifier: 'alice@example.com',
        failures: 5,
        locked: true,
      }),
    ]);
  });
});

describe('SecurityService.activeThrottleBlocks', () => {
  it('returns block entries with parsed throttler and tracker', async () => {
    const store = new Map<
      string,
      { value: string; ttl: number; pttl: number }
    >();
    const blockedUntil = Date.now() + 30_000;
    store.set('throttle-block:global:user:u-1', {
      value: String(blockedUntil),
      ttl: 30,
      pttl: 30_000,
    });

    const { service } = makeService({ redisStore: store });
    const out = await service.activeThrottleBlocks();
    expect(out).toHaveLength(1);
    expect(out[0]?.throttler).toBe('global');
    expect(out[0]?.tracker).toBe('user:u-1');
    expect(out[0]?.remainingMs).toBeGreaterThan(0);
  });
});

describe('SecurityService.revokeSession', () => {
  it('throws when session is unknown', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const { service } = makeService({ sessionFindUnique: findUnique });
    await expect(
      service.revokeSession(
        ADMIN,
        '00000000-0000-0000-0000-000000000099',
        { ip: '127.0.0.1', userAgent: 'jest' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates the session and writes an audit row', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 's-1',
      userId: 'u-1',
      revokedAt: null,
    });
    const update = jest.fn().mockResolvedValue(undefined);
    const { service, audit } = makeService({
      sessionFindUnique: findUnique,
      sessionUpdate: update,
    });

    await service.revokeSession(ADMIN, 's-1', {
      ip: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'security.session.revoke',
      entityType: 'Session',
      entityId: 's-1',
    });
  });
});

describe('SecurityService.connectionDiagnostics', () => {
  it('resolves via req.ip and flags a trusted private-bridge peer', () => {
    const { service } = makeService({});
    const out = service.connectionDiagnostics(
      makeReq({
        ip: '203.0.113.9', // Express already resolved the real client
        peer: '172.18.0.5', // the web container on the docker bridge
        xff: '203.0.113.9', // single sanitized entry the web tier emits
        inboundXff: '203.0.113.9',
      }),
    );

    expect(out.resolvedIp).toBe('203.0.113.9');
    expect(out.socketPeer).toBe('172.18.0.5');
    expect(out.peerTrusted).toBe(true);
    expect(out.forwardedForReceived).toBe('203.0.113.9');
    expect(out.trustProxyHops).toBe(1);
    // Always-present, non-overclaiming note.
    expect(out.interpretation[0]).toMatch(/Only the single sanitized resolvedIp/);
    // No "untrusted peer" note when the peer is on the bridge.
    expect(out.interpretation.some((n) => /not on the private/i.test(n))).toBe(
      false,
    );
  });

  it('flags an untrusted peer when the request did not arrive via the bridge', () => {
    const { service } = makeService({});
    const out = service.connectionDiagnostics(
      makeReq({
        ip: '8.8.8.8', // trust proxy did not honor XFF → socket peer
        peer: '8.8.8.8', // public peer, not the bridge
        xff: '1.2.3.4', // a value the client tried to forge
        inboundXff: '1.2.3.4',
      }),
    );

    expect(out.peerTrusted).toBe(false);
    expect(out.resolvedIp).toBe('8.8.8.8');
    expect(out.interpretation.some((n) => /not on the private/i.test(n))).toBe(
      true,
    );
  });

  it('echoes both raw chains display-only and length-bounds them', () => {
    const { service } = makeService({});
    const longChain = Array.from({ length: 100 }, () => '10.0.0.1').join(', ');
    const out = service.connectionDiagnostics(
      makeReq({
        ip: '203.0.113.9',
        peer: '172.18.0.5',
        xff: longChain, // e.g. a raw header under direct API exposure
        inboundXff: longChain,
      }),
    );

    // Both echoed header values bounded to the 500-char cap; never used
    // for attribution (resolvedIp stays the sanitized single entry).
    expect(out.inboundForwardedFor.length).toBeLessThanOrEqual(500);
    expect(out.inboundForwardedFor).toBe(longChain.slice(0, 500));
    expect(out.forwardedForReceived?.length).toBeLessThanOrEqual(500);
    expect(out.forwardedForReceived).toBe(longChain.slice(0, 500));
    expect(out.resolvedIp).toBe('203.0.113.9');
  });

  it('warns when TRUST_PROXY_HOPS=0 collapses attribution to the sentinel', () => {
    const { service } = makeService({ envValues: { TRUST_PROXY_HOPS: 0 } });
    const out = service.connectionDiagnostics(
      makeReq({ ip: '0.0.0.0', peer: '172.18.0.5' }),
    );

    expect(out.trustProxyHops).toBe(0);
    expect(out.resolvedIp).toBe('0.0.0.0');
    expect(out.forwardedForReceived).toBeNull();
    expect(out.inboundForwardedFor).toBe('');
    expect(out.interpretation.some((n) => /TRUST_PROXY_HOPS=0/.test(n))).toBe(
      true,
    );
    expect(out.interpretation.some((n) => /0\.0\.0\.0 sentinel/.test(n))).toBe(
      true,
    );
  });

  it('surfaces config-derived topology warnings for a public plain-HTTP APP_URL', () => {
    const { service } = makeService({
      envValues: { APP_URL: 'http://portal.example.com' },
    });
    const out = service.connectionDiagnostics(
      makeReq({ ip: '203.0.113.9', peer: '172.18.0.5', xff: '203.0.113.9' }),
    );
    // topologyWarnings flags plain HTTP on a public host.
    expect(out.interpretation.some((n) => /plain HTTP on a public host/.test(n))).toBe(
      true,
    );
  });
});
