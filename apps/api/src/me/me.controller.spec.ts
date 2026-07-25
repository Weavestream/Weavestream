import { MeController } from './me.controller.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';

/**
 * Pins the authorization configuration of the backup-code regeneration
 * route. A fresh set is ten single-use bypasses of the second factor —
 * a durable persistence credential — so the route must carry both a
 * step-up challenge (parity with admin reset-MFA in
 * `users.controller.ts`) and an edge-level throttle (parity with its
 * `change-password` sibling). Metadata assertions catch either decorator
 * being dropped in a refactor without booting the Nest app.
 *
 * The throttler keys are literals because `@nestjs/throttler` declares
 * `THROTTLER_TTL` / `THROTTLER_LIMIT` in its type definitions but does
 * not export them at runtime — importing them yields `undefined` and the
 * lookup silently misses. The `change-password` case below is the guard:
 * it asserts the same keys against a route whose throttle predates this
 * change, so if an upgrade renames them both tests fail together and the
 * cause is unambiguous.
 */
const THROTTLER_TTL_GLOBAL = 'THROTTLER:TTLglobal';
const THROTTLER_LIMIT_GLOBAL = 'THROTTLER:LIMITglobal';

describe('MeController regenerate route metadata', () => {
  function metadataOf(key: string, handler: keyof MeController): unknown {
    return Reflect.getMetadata(key, MeController.prototype[handler] as object);
  }

  it('regenerateMfaBackupCodes requires step-up re-authentication', () => {
    // Unconditional challenge: no `when` predicate — there is no variant
    // of this call that doesn't mint credentials.
    expect(metadataOf(REQUIRE_STEP_UP_KEY, 'regenerateMfaBackupCodes')).toEqual({});
  });

  it('regenerateMfaBackupCodes is capped at 10 requests per minute', () => {
    expect(metadataOf(THROTTLER_TTL_GLOBAL, 'regenerateMfaBackupCodes')).toBe(60_000);
    expect(metadataOf(THROTTLER_LIMIT_GLOBAL, 'regenerateMfaBackupCodes')).toBe(10);
  });

  it('change-password stays throttled — guards the key spelling above', () => {
    expect(metadataOf(THROTTLER_TTL_GLOBAL, 'changePassword')).toBe(60_000);
    expect(metadataOf(THROTTLER_LIMIT_GLOBAL, 'changePassword')).toBe(10);
  });
});
