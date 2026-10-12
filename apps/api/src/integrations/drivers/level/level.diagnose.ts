import type { IntegrationSetupCheck } from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError } from '../integration-driver.js';
import { LEVEL_SETUP_STEP as S } from './level.setup-guide.js';

/**
 * Check setup for Level: one read-only probe (the top-level groups). Every
 * outcome is a fixed message naming a guide step; Level's own error text
 * never reaches the client.
 */
export async function diagnoseLevel(probe: () => Promise<number>): Promise<IntegrationSetupCheck> {
  try {
    const roots = await probe();
    if (roots === 0) {
      return {
        ok: false,
        passedStepIds: [S.apiKey, S.credentials],
        failures: [{ stepId: S.organizations, message: 'The key works, but Level has no top-level groups. Put devices in a group in Level, then check again.' }],
      };
    }
    return { ok: true, passedStepIds: [S.apiKey, S.credentials, S.organizations], failures: [] };
  } catch (e) {
    if (e instanceof DriverRateLimitError) {
      return { ok: false, passedStepIds: [], failures: [{ stepId: null, message: 'Level is rate limiting requests right now. Wait a minute and press Check setup again.' }] };
    }
    if (e instanceof LevelKeyError) {
      return {
        ok: false,
        passedStepIds: [],
        failures: [{
          stepId: S.apiKey,
          message: e.status === 401
            ? 'Level does not accept this API key. It may be mistyped or revoked. Create a new key (step 1) and paste it again (step 2).'
            : 'This API key has no access to devices and groups. Create a key with Read-only access (step 1) and paste it again (step 2).',
        }],
      };
    }
    if (e instanceof DriverAuthError) {
      return { ok: false, passedStepIds: [], failures: [{ stepId: S.credentials, message: 'No API key is saved. Paste the key from Level and save (step 2).' }] };
    }
    return { ok: false, passedStepIds: [], failures: [{ stepId: null, message: 'Weavestream could not reach Level. Check that the server can reach the internet, then try again.' }] };
  }
}

/** A Level 401/403: the key is wrong, revoked, or lacks access. */
export class LevelKeyError extends DriverAuthError {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
    this.name = 'LevelKeyError';
  }
}
