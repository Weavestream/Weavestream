import type { IntegrationSetupCheck } from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError } from '../integration-driver.js';
import { NINJAONE_SETUP_STEP as S } from './ninjaone.setup-guide.js';

/** Which NinjaOne call failed: the token exchange or an API read. */
export type NinjaOneStage = 'token' | 'api';

/** A NinjaOne 400/401/403, or a token response without `access_token`. Keeps the DriverAuthError name and message. */
export class NinjaOneAuthError extends DriverAuthError {
  constructor(message: string, readonly stage: NinjaOneStage, readonly status: number) {
    super(message);
  }
}

/**
 * Any other non-OK NinjaOne response; carries the stage, the status and,
 * for a token 400, whether NinjaOne named `invalid_scope`.
 */
export class NinjaOneRequestError extends Error {
  constructor(
    message: string,
    readonly stage: NinjaOneStage,
    readonly status: number,
    readonly invalidScope = false,
  ) {
    super(message);
    this.name = 'NinjaOneRequestError';
  }
}

export interface NinjaOneDiagnoseInput {
  /** A Client ID and Client Secret are saved. */
  secretSaved: boolean;
  /** The saved API base URL parses (or is left at the default). */
  baseUrlValid: boolean;
  /** Fresh token exchange plus the organization list; resolves to the organization count. */
  probe: () => Promise<number>;
}

const fail = (stepId: string | null, message: string, passedStepIds: string[] = []): IntegrationSetupCheck => ({
  ok: false,
  passedStepIds,
  failures: [{ stepId, message }],
});

/** By name: `res.json()` can throw a SyntaxError from another realm, which fails `instanceof`. */
const errorName = (e: unknown): string => (typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '');

const BAD_CREDENTIALS = 'NinjaOne does not accept this Client ID and Client Secret. Check that both are pasted in full (step 3) and that the client app allows the Client Credentials grant type (step 1). If they are still refused, create a new client app (step 1).';
// NinjaOne answers an unknown Client ID with 404, so a wrong region looks the same.
const UNKNOWN_CLIENT = 'NinjaOne does not know this Client ID at the saved API base URL. Use the URL for the region you sign in to (step 2), and check that the Client ID is pasted in full (step 3).';
const NO_MONITORING_SCOPE = 'The client app does not have the Monitoring scope. Edit the client app in NinjaOne, select Monitoring (step 1), then check again.';
const WRONG_BASE_URL = 'The API base URL does not point to the NinjaOne API. Use the URL for your region (step 2) and save.';

/**
 * Check setup for NinjaOne: one read-only probe (token exchange, then the
 * organization list). Every outcome is a fixed message naming a guide step;
 * NinjaOne's own error text never reaches the client.
 */
export async function diagnoseNinjaOne(input: NinjaOneDiagnoseInput): Promise<IntegrationSetupCheck> {
  if (!input.secretSaved) {
    return fail(S.credentials, 'No Client ID and Client Secret are saved. Paste both from NinjaOne and save (step 3).');
  }
  if (!input.baseUrlValid) {
    return fail(S.region, 'The saved API base URL is not a valid URL. Use the URL for your region (step 2) and save.');
  }
  try {
    const orgs = await input.probe();
    if (orgs === 0) {
      return fail(
        S.organizations,
        'The credentials work, but NinjaOne returned no organizations. Add an organization in NinjaOne, then check again.',
        [S.apiClient, S.region, S.credentials],
      );
    }
    return { ok: true, passedStepIds: [S.apiClient, S.region, S.credentials, S.organizations], failures: [] };
  } catch (e) {
    if (e instanceof DriverRateLimitError) {
      return fail(null, 'NinjaOne is rate limiting requests right now. Wait a minute and press Check setup again.');
    }
    if (e instanceof NinjaOneAuthError) {
      if (e.stage === 'token') return e.status >= 200 && e.status < 300 ? fail(S.region, WRONG_BASE_URL) : fail(S.apiClient, BAD_CREDENTIALS);
      // A fresh token that cannot list organizations lacks the read scope.
      if (e.status === 403) return fail(S.apiClient, NO_MONITORING_SCOPE, [S.region, S.credentials]);
      return fail(S.apiClient, BAD_CREDENTIALS);
    }
    if (e instanceof NinjaOneRequestError) {
      if (e.stage === 'token' && e.status === 400) return e.invalidScope ? fail(S.apiClient, NO_MONITORING_SCOPE) : fail(S.apiClient, BAD_CREDENTIALS);
      if (e.stage === 'token' && e.status === 404) return fail(S.region, UNKNOWN_CLIENT);
      if (e.status === 404 || e.status === 405) return fail(S.region, WRONG_BASE_URL);
      return fail(null, 'NinjaOne did not answer as expected. Try again in a few minutes.');
    }
    // An HTML or other non-JSON body: the host is not the NinjaOne API.
    if (errorName(e) === 'SyntaxError') return fail(S.region, WRONG_BASE_URL);
    // The host does not resolve or points to a private address.
    if (errorName(e) === 'EgressBlockedError') {
      return fail(S.region, 'Weavestream cannot connect to the saved API base URL. Check the URL for your region (step 2).');
    }
    return fail(null, 'Weavestream could not reach NinjaOne. Check that the server can reach the internet, then try again.');
  }
}
