// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import {
  Controller,
  HttpCode,
  Post,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthThrottle } from '../../common/public.decorator.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { RedisService } from '../../redis/redis.service.js';
import {
  authThrottler,
  authThrottleSkipIf,
  authThrottleTracker,
} from './auth-throttle.js';
import { UserThrottlerGuard } from './user-throttler.guard.js';

describe('authThrottleTracker', () => {
  const req = (overrides: Record<string, unknown>) =>
    ({ ip: '1.2.3.4', ...overrides }) as Record<string, any>;

  it('keys on the (ip, email) pair', () => {
    expect(authThrottleTracker(req({ body: { email: 'user@example.com' } }))).toBe(
      'ip:1.2.3.4:email:user@example.com',
    );
  });

  it('normalizes case and surrounding whitespace so variants share a bucket', () => {
    expect(authThrottleTracker(req({ body: { email: '  User@Example.COM ' } }))).toBe(
      'ip:1.2.3.4:email:user@example.com',
    );
  });

  it('caps the email component at 320 chars', () => {
    const email = `${'a'.repeat(400)}@example.com`;
    const tracker = authThrottleTracker(req({ body: { email } }));
    expect(tracker).toBe(`ip:1.2.3.4:email:${email.slice(0, 320)}`);
  });

  it('falls back to the ip-only bucket when the email is not a string', () => {
    expect(authThrottleTracker(req({ body: { email: 42 } }))).toBe('ip:1.2.3.4');
    expect(authThrottleTracker(req({ body: { email: { $ne: '' } } }))).toBe(
      'ip:1.2.3.4',
    );
  });

  it('falls back to the ip-only bucket when the body has no email', () => {
    expect(authThrottleTracker(req({ body: {} }))).toBe('ip:1.2.3.4');
    expect(authThrottleTracker(req({}))).toBe('ip:1.2.3.4');
  });

  it('treats a whitespace-only email as absent', () => {
    expect(authThrottleTracker(req({ body: { email: '   ' } }))).toBe('ip:1.2.3.4');
  });

  it('falls back to the socket address, then "unknown", when req.ip is missing', () => {
    expect(
      authThrottleTracker({ socket: { remoteAddress: '5.6.7.8' }, body: {} }),
    ).toBe('ip:5.6.7.8');
    expect(authThrottleTracker({ body: {} })).toBe('ip:unknown');
  });
});

describe('authThrottleSkipIf', () => {
  class FakeController {
    @AuthThrottle()
    login() {}

    other() {}
  }

  const ctxFor = (handler: () => void): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => FakeController,
    }) as unknown as ExecutionContext;

  it('does not skip routes marked @AuthThrottle()', () => {
    expect(authThrottleSkipIf(ctxFor(FakeController.prototype.login))).toBe(false);
  });

  it('skips undecorated routes', () => {
    expect(authThrottleSkipIf(ctxFor(FakeController.prototype.other))).toBe(true);
  });
});

describe('auth throttler enforcement (integration)', () => {
  @Controller()
  class FakeAuthController {
    @AuthThrottle()
    @Post('login')
    @HttpCode(200)
    login() {
      return { ok: true };
    }

    @Post('other')
    @HttpCode(200)
    other() {
      return { ok: true };
    }
  }

  // Fresh module + in-memory throttler storage per app so counter
  // state can't bleed between limit cases. The guard's rejection-audit
  // deps are mocked; `redisSet` gates the coalescing claim.
  async function makeApp(
    limit: number,
    {
      auditLog = jest.fn().mockResolvedValue(undefined),
      redisSet = jest.fn().mockResolvedValue('OK'),
    } = {},
  ): Promise<{ app: INestApplication; auditLog: jest.Mock; redisSet: jest.Mock }> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'global', ttl: 60_000, limit: 600 },
            authThrottler(limit),
          ],
        }),
      ],
      controllers: [FakeAuthController],
      providers: [
        { provide: APP_GUARD, useClass: UserThrottlerGuard },
        { provide: AuditLogService, useValue: { log: auditLog } },
        { provide: RedisService, useValue: { client: { set: redisSet } } },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { app, auditLog, redisSet };
  }

  it('throttles the login route per (ip, email) pair at the configured limit', async () => {
    const { app } = await makeApp(2);
    try {
      const http = app.getHttpServer();
      // Case/whitespace variants of one address share the bucket.
      await request(http).post('/login').send({ email: 'A@Example.com ' }).expect(200);
      await request(http).post('/login').send({ email: 'a@example.com' }).expect(200);
      const blocked = await request(http)
        .post('/login')
        .send({ email: 'a@EXAMPLE.com' })
        .expect(429);
      expect(blocked.headers['retry-after-auth']).toBeDefined();

      // A different email from the same IP is a separate bucket.
      await request(http).post('/login').send({ email: 'b@example.com' }).expect(200);

      // Routes without @AuthThrottle() are not subject to the auth limit.
      for (let i = 0; i < 4; i++) {
        await request(http).post('/other').send({ email: 'a@example.com' }).expect(200);
      }
    } finally {
      await app.close();
    }
  });

  it('enforces whatever limit the throttler is constructed with', async () => {
    const { app } = await makeApp(3);
    try {
      const http = app.getHttpServer();
      for (let i = 0; i < 3; i++) {
        await request(http).post('/login').send({ email: 'a@example.com' }).expect(200);
      }
      await request(http).post('/login').send({ email: 'a@example.com' }).expect(429);
    } finally {
      await app.close();
    }
  });

  it('throttles bodies without a usable email in a shared ip-only bucket', async () => {
    const { app } = await makeApp(2);
    try {
      const http = app.getHttpServer();
      // Guards run before the ValidationPipe, so these unvalidated
      // shapes must land in the ip bucket — throttled, not exempt.
      await request(http).post('/login').send({}).expect(200);
      await request(http).post('/login').send({ email: 42 }).expect(200);
      await request(http)
        .post('/login')
        .send({ email: { $ne: '' } })
        .expect(429);
    } finally {
      await app.close();
    }
  });

  it('audits a rejection once per claimed window while repeated 429s stay coalesced', async () => {
    // First claim wins, later claims report "already taken".
    const redisSet = jest
      .fn()
      .mockResolvedValueOnce('OK')
      .mockResolvedValue(null);
    const { app, auditLog } = await makeApp(1, { redisSet });
    try {
      const http = app.getHttpServer();
      await request(http).post('/login').send({ email: 'a@example.com' }).expect(200);
      const blocked = await request(http)
        .post('/login')
        .send({ email: 'a@example.com' })
        .expect(429);
      // Wire behavior unchanged: stock 429 + Retry-After header.
      expect(blocked.headers['retry-after-auth']).toBeDefined();
      await request(http).post('/login').send({ email: 'a@example.com' }).expect(429);
      await request(http).post('/login').send({ email: 'a@example.com' }).expect(429);

      // Detached audit work — flush before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(auditLog).toHaveBeenCalledTimes(1);
      const entry = auditLog.mock.calls[0]?.[0] as {
        action: string;
        after: { limiter: string; attemptedEmail?: string };
      };
      expect(entry.action).toBe('security.ratelimit.blocked');
      expect(entry.after.limiter).toBe('auth');
      expect(entry.after.attemptedEmail).toBe('a@example.com');

      // The coalescing key is the hashed generated key — never the raw
      // tracker, which embeds the attempted email for the auth limiter.
      const claimKey = redisSet.mock.calls[0]?.[0] as string;
      expect(claimKey.startsWith('secalert:throttle:auth:')).toBe(true);
      expect(claimKey).not.toContain('example.com');
    } finally {
      await app.close();
    }
  });
});

// Direct tests of the rejection-audit override: crafted ThrottlerLimitDetail
// values prove the millisecond→second conversion against Redis-storage-shaped
// inputs. (The in-memory storage used by the integration harness reports
// SECONDS; the production RedisThrottlerStorage reports MILLISECONDS — a
// unit bug here coalesces alerts for ~16 hours instead of 60s, so these
// assertions pin the actual TTL/payload values, not just "it deduplicates".)
describe('UserThrottlerGuard rejection audit (unit)', () => {
  function makeGuard({
    redisSet = jest.fn().mockResolvedValue('OK'),
    auditLog = jest.fn().mockResolvedValue(undefined),
  } = {}) {
    const storage = { increment: jest.fn() };
    const guard = new UserThrottlerGuard(
      { throttlers: [] } as never,
      storage as never,
      new Reflector(),
      { log: auditLog } as never,
      { client: { set: redisSet } } as never,
    );
    return { guard, storage, redisSet, auditLog };
  }

  function requestPropsFor({
    guard,
    storage,
    throttlerName = 'auth',
    req,
    detail,
  }: {
    guard: UserThrottlerGuard;
    storage: { increment: jest.Mock };
    throttlerName?: string;
    req: Record<string, unknown>;
    detail: Partial<{
      totalHits: number;
      timeToExpire: number;
      isBlocked: boolean;
      timeToBlockExpire: number;
    }>;
  }) {
    const res = { header: jest.fn() };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as never;
    storage.increment.mockResolvedValue({
      totalHits: 6,
      timeToExpire: 0,
      isBlocked: true,
      timeToBlockExpire: 60_000,
      ...detail,
    });
    const requestProps = {
      context,
      limit: 5,
      ttl: 60_000,
      throttler: {
        name: throttlerName,
        ttl: 60_000,
        limit: 5,
        ignoreUserAgents: [],
        setHeaders: true,
      },
      blockDuration: 60_000,
      getTracker: async () => 'ip:203.0.113.9:email:v@example.com',
      generateKey: () => 'HASHEDKEY123',
    };
    const handleRequest = (
      guard as unknown as {
        handleRequest: (p: unknown) => Promise<boolean>;
      }
    ).handleRequest.bind(guard);
    return { requestProps, res, handleRequest };
  }

  const baseReq = () => ({
    ip: '203.0.113.9',
    method: 'POST',
    path: '/api/v1/auth/login',
    headers: { 'user-agent': 'UnitUA/1.0' },
    body: { email: '  V@Example.COM ' },
    socket: {},
  });

  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('converts millisecond block windows to whole seconds for the claim TTL and payload', async () => {
    const ctx = makeGuard();
    const { requestProps, res, handleRequest } = requestPropsFor({
      guard: ctx.guard,
      storage: ctx.storage,
      req: baseReq(),
      detail: { timeToBlockExpire: 60_000, timeToExpire: 0 },
    });

    await expect(handleRequest(requestProps)).rejects.toThrow(ThrottlerException);
    // Existing wire behavior: raw storage value on the header, name-suffixed.
    expect(res.header).toHaveBeenCalledWith('Retry-After-auth', 60_000);

    await flush();
    expect(ctx.redisSet).toHaveBeenCalledWith(
      'secalert:throttle:auth:HASHEDKEY123',
      '1',
      'EX',
      60, // seconds — NOT 60_000
      'NX',
    );
    expect(ctx.auditLog).toHaveBeenCalledTimes(1);
    expect(ctx.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security.ratelimit.blocked',
        actorId: null,
        entityType: 'RateLimit',
        ip: '203.0.113.9',
        userAgent: 'UnitUA/1.0',
        after: {
          limiter: 'auth',
          limit: 5,
          windowSec: 60, // ttl 60_000ms → 60s
          route: '/api/v1/auth/login',
          method: 'POST',
          retryAfterSec: 60,
          attemptedEmail: 'v@example.com',
        },
      }),
    );
  });

  it('falls back to timeToExpire when there is no block window', async () => {
    const ctx = makeGuard();
    const { requestProps, handleRequest } = requestPropsFor({
      guard: ctx.guard,
      storage: ctx.storage,
      req: baseReq(),
      detail: { timeToBlockExpire: 0, timeToExpire: 30_000 },
    });
    await expect(handleRequest(requestProps)).rejects.toThrow(ThrottlerException);
    await flush();
    expect(ctx.redisSet).toHaveBeenCalledWith(
      expect.any(String),
      '1',
      'EX',
      30,
      'NX',
    );
    const entry = ctx.auditLog.mock.calls[0]?.[0] as {
      after: { retryAfterSec: number };
    };
    expect(entry.after.retryAfterSec).toBe(30);
  });

  it('omits attemptedEmail for non-auth limiters and records the acting user', async () => {
    const ctx = makeGuard();
    const req = { ...baseReq(), user: { id: 'user-42' } };
    const { requestProps, handleRequest } = requestPropsFor({
      guard: ctx.guard,
      storage: ctx.storage,
      throttlerName: 'global',
      req,
      detail: {},
    });
    await expect(handleRequest(requestProps)).rejects.toThrow(ThrottlerException);
    await flush();
    const entry = ctx.auditLog.mock.calls[0]?.[0] as {
      actorId: string | null;
      after: Record<string, unknown>;
    };
    expect(entry.actorId).toBe('user-42');
    expect(entry.after.limiter).toBe('global');
    expect(entry.after).not.toHaveProperty('attemptedEmail');
  });

  it('bounds attacker-controlled route and user agent', async () => {
    const ctx = makeGuard();
    const req = {
      ...baseReq(),
      path: undefined,
      url: `/${'r'.repeat(600)}?q=1`,
      headers: { 'user-agent': 'u'.repeat(700) },
    };
    const { requestProps, handleRequest } = requestPropsFor({
      guard: ctx.guard,
      storage: ctx.storage,
      req,
      detail: {},
    });
    await expect(handleRequest(requestProps)).rejects.toThrow(ThrottlerException);
    await flush();
    const entry = ctx.auditLog.mock.calls[0]?.[0] as {
      userAgent: string;
      after: { route: string };
    };
    expect(entry.userAgent).toHaveLength(500);
    expect(entry.after.route.length).toBeLessThanOrEqual(300);
    expect(entry.after.route).not.toContain('?');
  });

  it('skips the audit when the window is already claimed, and never breaks the 429', async () => {
    const ctx = makeGuard({ redisSet: jest.fn().mockResolvedValue(null) });
    const { requestProps, handleRequest } = requestPropsFor({
      guard: ctx.guard,
      storage: ctx.storage,
      req: baseReq(),
      detail: {},
    });
    await expect(handleRequest(requestProps)).rejects.toThrow(ThrottlerException);
    await flush();
    expect(ctx.auditLog).not.toHaveBeenCalled();
  });

  it('a rejecting audit write never breaks the 429 (detached best-effort)', async () => {
    const ctx = makeGuard({
      auditLog: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const { requestProps, handleRequest } = requestPropsFor({
      guard: ctx.guard,
      storage: ctx.storage,
      req: baseReq(),
      detail: {},
    });
    await expect(handleRequest(requestProps)).rejects.toThrow(ThrottlerException);
    await flush();
  });
});
