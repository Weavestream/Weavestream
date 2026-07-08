import 'reflect-metadata';
import { IpRulesController } from './ip-rules.controller.js';
import { InternalOnlyGuard } from '../common/internal-only.guard.js';

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
