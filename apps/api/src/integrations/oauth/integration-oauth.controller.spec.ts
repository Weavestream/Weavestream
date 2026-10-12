import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants.js';
import { OAuthCallbackRedirectFilter } from './oauth-callback-redirect.filter.js';
import { REQUIRE_PERMISSION_KEY } from '../../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../../auth/step-up/require-step-up.decorator.js';
import { INTERACTIVE_ONLY_KEY } from '../../auth/interactive-only.decorator.js';
import { IntegrationOAuthController } from './integration-oauth.controller.js';

const meta = (key: string, target: object) => Reflect.getMetadata(key, target);

describe('IntegrationOAuthController security contract', () => {
  const proto = IntegrationOAuthController.prototype;

  it('is interactive-only for every route', () => {
    expect(meta(INTERACTIVE_ONLY_KEY, IntegrationOAuthController)).toBe(true);
  });

  it.each(['callback', 'getApp', 'updateApp', 'checkApp', 'listConnections', 'start', 'disconnect'] as const)(
    '%s requires integration.manage',
    (handler) => {
      expect(meta(REQUIRE_PERMISSION_KEY, proto[handler])).toEqual({
        action: 'integration.manage',
        companyIdFrom: undefined,
      });
    },
  );

  it.each(['updateApp', 'start', 'disconnect'] as const)('%s requires step-up', (handler) => {
    expect(meta(REQUIRE_STEP_UP_KEY, proto[handler])).toEqual({});
  });

  it.each(['getApp', 'checkApp', 'listConnections'] as const)('%s needs no step-up (read-only)', (handler) => {
    expect(meta(REQUIRE_STEP_UP_KEY, proto[handler])).toBeUndefined();
  });

  it('passes the reconnect intent and connection ids through unchanged', async () => {
    const oauth = { start: jest.fn().mockResolvedValue({ authorizeUrl: 'x' }), disconnect: jest.fn() };
    const controller = new IntegrationOAuthController(oauth as never, {} as never);
    const user = { id: 'user-1' } as never;
    await controller.start(user, 'i-1', { connectionId: 'c-1' });
    expect(oauth.start).toHaveBeenCalledWith(user, 'i-1', { connectionId: 'c-1' });
    await controller.disconnect(user, 'i-1', 'c-1', { ip: '127.0.0.1', headers: {} } as never);
    expect(oauth.disconnect).toHaveBeenCalledWith(user, 'i-1', 'c-1', expect.any(Object));
  });

  it('redirects the browser to the landing URL from the service', async () => {
    const callback = jest.fn().mockResolvedValue('https://ws.example.test/admin/integrations/x?oauth=failed');
    const controller = new IntegrationOAuthController({ callback } as never, {} as never);
    const res = { redirect: jest.fn() };
    const user = { id: 'user-1' } as never;
    await controller.callback(
      user,
      { state: 's', code: 'c' },
      { ip: '127.0.0.1', headers: {} } as never,
      res as never,
    );
    expect(callback).toHaveBeenCalledWith(user, { state: 's', code: 'c' }, expect.any(Object));
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://ws.example.test/admin/integrations/x?oauth=failed',
    );
  });
});

describe('OAuth callback guard failures redirect the browser', () => {
  const env = { values: { APP_URL: 'https://app.example.com/' } };
  function run(exception: unknown) {
    const redirect = jest.fn();
    const host = { switchToHttp: () => ({ getResponse: () => ({ redirect }) }) };
    new OAuthCallbackRedirectFilter(env as never).catch(exception, host as never);
    return redirect;
  }

  it('is bound to the callback route', () => {
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, IntegrationOAuthController.prototype.callback))
      .toEqual([OAuthCallbackRedirectFilter]);
  });

  it('sends an expired session to the login page instead of a JSON 401', () => {
    expect(run(new UnauthorizedException())).toHaveBeenCalledWith(302, 'https://app.example.com/login');
  });

  it.each([new ForbiddenException(), new Error('boom')])('sends other failures to the failure landing (%s)', (error) => {
    expect(run(error)).toHaveBeenCalledWith(302, 'https://app.example.com/admin/integrations?oauth=failed');
  });
});
