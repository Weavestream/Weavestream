import { updateMcpClientPolicySchema } from '@weavestream/shared';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { INTERACTIVE_ONLY_KEY } from '../auth/interactive-only.decorator.js';
import { SettingsController } from './settings.controller.js';

const meta = (key: string, target: object) => Reflect.getMetadata(key, target);

describe('SettingsController access settings', () => {
  const proto = SettingsController.prototype;

  // `@InteractiveOnly()` is what refuses an API key or a remote AI
  // connection: neither can change which apps may connect.
  it.each(['setApiKeys', 'setMcpRemote', 'setMcpClientPolicy'] as const)(
    '%s needs settings.manage, a step-up and an interactive session',
    (method) => {
      expect(meta(REQUIRE_PERMISSION_KEY, proto[method])).toEqual({
        action: 'settings.manage',
        companyIdFrom: undefined,
      });
      expect(meta(REQUIRE_STEP_UP_KEY, proto[method])).toEqual({});
      expect(meta(INTERACTIVE_ONLY_KEY, proto[method])).toBe(true);
    },
  );

  it('accepts only the two client policies', () => {
    expect(updateMcpClientPolicySchema.safeParse({ policy: 'claude_chatgpt' }).success).toBe(true);
    expect(updateMcpClientPolicySchema.safeParse({ policy: 'any' }).success).toBe(true);
    for (const body of [{ policy: 'all' }, { policy: '' }, {}, { policy: 'any', hosts: ['x'] }]) {
      expect(updateMcpClientPolicySchema.safeParse(body).success).toBe(false);
    }
  });

  it('passes the policy and request meta to the service', async () => {
    const settings = { setMcpClientPolicy: jest.fn().mockResolvedValue({ mcpClientPolicy: 'any' }) };
    const controller = new SettingsController(settings as never);
    const user = { id: 'u1' } as never;
    const req = { headers: { 'user-agent': 'jest' }, ip: '127.0.0.1', socket: {} } as never;
    await controller.setMcpClientPolicy(user, { policy: 'any' }, req);
    expect(settings.setMcpClientPolicy).toHaveBeenCalledWith(user, 'any', expect.objectContaining({ userAgent: 'jest' }));
  });
});
