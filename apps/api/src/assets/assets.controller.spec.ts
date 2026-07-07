import { AssetsController } from './assets.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';

/**
 * Pins the authorization configuration of the destructive asset routes
 * (WS-015). Purge is irreversible, so both the single-item and bulk
 * handlers must carry `asset.purge` (FULL access) AND a step-up
 * re-authentication challenge. Metadata assertions catch a decorator
 * being dropped in a refactor without booting the Nest app.
 */
describe('AssetsController purge route metadata', () => {
  function metadataOf(key: string, handler: string): unknown {
    return Reflect.getMetadata(
      key,
      AssetsController.prototype[handler as keyof AssetsController] as object,
    );
  }

  it.each(['purge', 'bulkPurge'])(
    '%s requires the asset.purge permission scoped to the route company',
    (handler) => {
      expect(metadataOf(REQUIRE_PERMISSION_KEY, handler)).toEqual({
        action: 'asset.purge',
        companyIdFrom: 'params.companyId',
      });
    },
  );

  it.each(['purge', 'bulkPurge'])(
    '%s requires step-up re-authentication',
    (handler) => {
      // Unconditional challenge: no `when` predicate — purge is always
      // destructive.
      expect(metadataOf(REQUIRE_STEP_UP_KEY, handler)).toEqual({});
    },
  );
});
