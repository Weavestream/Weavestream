import 'reflect-metadata';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { INTERACTIVE_ONLY_KEY } from '../auth/interactive-only.decorator.js';
import { SsoSettingsController } from './sso-settings.controller.js';

const proto = SsoSettingsController.prototype as unknown as Record<string, () => unknown>;
const handlerMeta = (key: string, name: string) => Reflect.getMetadata(key, proto[name]!);

describe('SsoSettingsController metadata', () => {
  it('is interactive-only as a whole (no API key or AI connection)', () => {
    expect(Reflect.getMetadata(INTERACTIVE_ONLY_KEY, SsoSettingsController)).toBe(true);
  });

  it.each(['get', 'update', 'test'])('%s requires settings.manage', (name) => {
    expect(handlerMeta(REQUIRE_PERMISSION_KEY, name)).toEqual({ action: 'settings.manage' });
  });

  it('PATCH requires step-up; GET and test do not', () => {
    expect(handlerMeta(REQUIRE_STEP_UP_KEY, 'update')).toEqual({});
    expect(handlerMeta(REQUIRE_STEP_UP_KEY, 'get')).toBeUndefined();
    expect(handlerMeta(REQUIRE_STEP_UP_KEY, 'test')).toBeUndefined();
  });

  it('serves /settings/sso under v1', () => {
    expect(Reflect.getMetadata('path', SsoSettingsController)).toBe('settings/sso');
    expect(Reflect.getMetadata('__routePath__', SsoSettingsController)).toBeUndefined();
  });

  it('rate-limits the test route', () => {
    const keys = Reflect.getMetadataKeys(proto['test']!).filter((k: string) => k.startsWith('THROTTLER:LIMIT'));
    expect(keys.length).toBeGreaterThan(0);
  });

  it('delegates update with the actor and request meta', async () => {
    const settings = { update: jest.fn(async () => ({ ok: 1 })), get: jest.fn(), test: jest.fn() };
    const c = new SsoSettingsController(settings as never);
    const user = { id: 'u-1' };
    await c.update(user as never, { enabled: false }, { ip: '203.0.113.7', headers: { 'user-agent': 'jest' } } as never);
    expect(settings.update).toHaveBeenCalledWith(user, { enabled: false }, expect.objectContaining({ ip: expect.any(String) }));
  });
});
