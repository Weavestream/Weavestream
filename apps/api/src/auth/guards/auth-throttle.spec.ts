// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import {
  Controller,
  HttpCode,
  Post,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthThrottle } from '../../common/public.decorator.js';
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
  // state can't bleed between limit cases.
  async function makeApp(limit: number): Promise<INestApplication> {
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
      providers: [{ provide: APP_GUARD, useClass: UserThrottlerGuard }],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  it('throttles the login route per (ip, email) pair at the configured limit', async () => {
    const app = await makeApp(2);
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
    const app = await makeApp(3);
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
    const app = await makeApp(2);
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
});
