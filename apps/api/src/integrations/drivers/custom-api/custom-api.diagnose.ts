import type { IntegrationSetupCheck } from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError } from '../integration-driver.js';
import { CustomApiAuthError, CustomApiRequestError } from './custom-api.http.js';
import { CUSTOM_API_SETUP_STEP as S } from './custom-api.setup-guide.js';

/** The probe sees the organizations, not this integration's company mappings. */
export const ORGANIZATIONS_UNVERIFIED_NOTE = 'The API returns organizations. Check setup does not check mappings: map each organization to a company on Organizations.';

/** Refusal of a saved definition that does not validate; fixed text. */
export class CustomApiDefinitionError extends Error {
  constructor() {
    super('The saved API definition is not valid. Open the Credentials & schedule tab and save it again.');
    this.name = 'CustomApiDefinitionError';
  }
}

/**
 * Check setup for a Custom API integration: one read of the organizations.
 * Every outcome is a fixed message naming a guide step; the API's own
 * error text never reaches the client.
 */
export async function diagnoseCustomApi(probe: () => Promise<number>): Promise<IntegrationSetupCheck> {
  try {
    const orgs = await probe();
    if (orgs === 0) {
      return {
        ok: false,
        passedStepIds: [S.definition, S.credentials],
        failures: [{ stepId: S.organizations, message: 'The API answered, but no organizations were found. Check the Organizations section, then check again.' }],
      };
    }
    return {
      ok: true,
      passedStepIds: [S.definition, S.credentials],
      failures: [],
      notes: [{ stepId: S.organizations, message: ORGANIZATIONS_UNVERIFIED_NOTE }],
    };
  } catch (e) {
    if (e instanceof DriverRateLimitError) {
      return { ok: false, passedStepIds: [], failures: [{ stepId: null, message: 'The API is rate limiting requests right now. Wait a minute and press Check setup again.' }] };
    }
    if (e instanceof CustomApiDefinitionError) {
      return { ok: false, passedStepIds: [], failures: [{ stepId: S.definition, message: e.message }] };
    }
    if (e instanceof CustomApiAuthError || e instanceof DriverAuthError) {
      return {
        ok: false,
        passedStepIds: [S.definition],
        failures: [{ stepId: S.credentials, message: e instanceof CustomApiAuthError && e.status !== null ? e.message : 'The credentials are not saved. Enter them and save (step 2).' }],
      };
    }
    if (e instanceof CustomApiRequestError) {
      return { ok: false, passedStepIds: [], failures: [{ stepId: S.definition, message: e.message }] };
    }
    return { ok: false, passedStepIds: [], failures: [{ stepId: null, message: 'Weavestream could not reach the API. Check the Base URL, then try again.' }] };
  }
}
