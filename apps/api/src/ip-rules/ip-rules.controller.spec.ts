import 'reflect-metadata';
import { IpRulesController } from './ip-rules.controller.js';
import { InternalOnlyGuard } from '../common/internal-only.guard.js';
import { SKIP_CSRF_KEY } from '../common/public.decorator.js';

// Regression guard for WS-028: the internal `active` endpoint must stay
// behind InternalOnlyGuard. Dropping the @UseGuards would pass every other
// test while re-exposing the ruleset through the blind proxy, so pin the
// wiring directly.
describe('IpRulesController.active guard wiring', () => {
  it('is protected by InternalOnlyGuard', () => {
    const guards =
      Reflect.getMetadata('__guards__', IpRulesController.prototype.active) ?? [];
    expect(guards).toContain(InternalOnlyGuard);
  });
});

// Same regression class for the blocked-report endpoint: every decorator
// here is load-bearing (see the controller comment). Losing the guard
// re-exposes an unauthenticated write path through the blind proxy;
// losing SkipCsrf silently breaks every proxy report (POST + @Public
// does not exempt CSRF); losing the global-throttle skip lets a
// distributed scan starve the endpoint via the web container's shared
// peer identity.
describe('IpRulesController.blockedReport guard wiring', () => {
  const handler = IpRulesController.prototype.blockedReport;

  it('is protected by InternalOnlyGuard', () => {
    const guards = Reflect.getMetadata('__guards__', handler) ?? [];
    expect(guards).toContain(InternalOnlyGuard);
  });

  it('skips CSRF (POST from the web proxy carries no CSRF token)', () => {
    expect(Reflect.getMetadata(SKIP_CSRF_KEY, handler)).toBe(true);
  });

  it('skips the global throttler by name', () => {
    // @nestjs/throttler's SkipThrottle writes THROTTLER:SKIP<name>.
    expect(Reflect.getMetadata('THROTTLER:SKIPglobal', handler)).toBe(true);
  });

  it('forwards the validated body to recordBlockedRequest with source "web"', async () => {
    const recordBlockedRequest = jest.fn().mockResolvedValue(undefined);
    const controller = new IpRulesController({
      recordBlockedRequest,
    } as never);
    await controller.blockedReport({
      ip: '203.0.113.9',
      cidr: '203.0.113.0/24',
      priority: 2,
      path: '/login',
      userAgent: 'UA/1.0',
    });
    expect(recordBlockedRequest).toHaveBeenCalledWith(
      {
        ip: '203.0.113.9',
        cidr: '203.0.113.0/24',
        priority: 2,
        path: '/login',
        userAgent: 'UA/1.0',
      },
      'web',
    );
  });
});
