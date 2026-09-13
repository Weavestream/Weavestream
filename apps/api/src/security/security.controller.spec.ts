import 'reflect-metadata';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { SecurityController } from './security.controller.js';

// The IP rule coverage read joins the other Security Center reads behind
// `security.read`. The global PermissionGuard is default-deny, so a
// missing decorator would fail closed; what this pins is the action
// itself, so the endpoint cannot drift to `@AuthedOnly()` or a weaker
// action unnoticed.
describe('SecurityController.ipRuleCoverage', () => {
  const handler = SecurityController.prototype.ipRuleCoverage;

  it('requires the security.read action', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toMatchObject({
      action: 'security.read',
    });
  });

  it('returns only the catch-all gap, never the rule list', async () => {
    const gap = { family: 'IPv4', uncoveredFamily: 'IPv6', cidr: '0.0.0.0/0' };
    const ipRules = {
      catchAllFamilyGap: jest.fn().mockResolvedValue(gap),
      list: jest.fn(),
      loadEnabledRules: jest.fn(),
    };
    const controller = new SecurityController({} as never, ipRules as never);

    await expect(controller.ipRuleCoverage()).resolves.toEqual({ gap });
    expect(ipRules.list).not.toHaveBeenCalled();
    expect(ipRules.loadEnabledRules).not.toHaveBeenCalled();
  });
});
