import type { IntegrationSetupCheck } from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError } from '../integration-driver.js';
import { ACTION1_SETUP_STEP as S } from './action1.setup-guide.js';

/** Which Action1 call failed: the token exchange or an API read. */
export type Action1Stage = 'token' | 'api';

/** An Action1 401/403, or a token response without `access_token`. Keeps the DriverAuthError name and message. */
export class Action1AuthError extends DriverAuthError {
  constructor(message: string, readonly stage: Action1Stage, readonly status: number) {
    super(message);
  }
}

/** Any other non-OK Action1 response; carries only the stage and status. */
export class Action1RequestError extends Error {
  constructor(message: string, readonly stage: Action1Stage, readonly status: number) {
    super(message);
    this.name = 'Action1RequestError';
  }
}

export interface Action1DiagnoseInput {
  /** A Client ID and Client Secret are saved. */
  secretSaved: boolean;
  /** The saved API base URL parses (or is left at the default). */
  baseUrlValid: boolean;
  /** Token exchange plus the organization list; resolves to the organization count. */
  probe: () => Promise<number>;
}

const fail = (stepId: string | null, message: string, passedStepIds: string[] = []): IntegrationSetupCheck => ({
  ok: false,
  passedStepIds,
  failures: [{ stepId, message }],
});

/** By name: `res.json()` can throw a SyntaxError from another realm, which fails `instanceof`. */
const errorName = (e: unknown): string => (typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '');

export const ORGANIZATIONS_UNVERIFIED_NOTE = 'The credentials see your Action1 organizations. Check setup does not check mappings: map each organization to a company on Organizations.';

const BAD_CREDENTIALS = 'Action1 does not accept this Client ID and Client Secret. Check that both are pasted in full (step 3) and that the API base URL is for the region of your Action1 account (step 2). If they are still refused, create new credentials (step 1).';
const WRONG_BASE_URL = 'The API base URL does not point to the Action1 API. Use the URL for your region (step 2) and save.';

/**
 * Check setup for Action1: one read-only probe (token exchange, then the
 * organization list). Every outcome is a fixed message naming a guide step;
 * Action1's own error text never reaches the client.
 */
export async function diagnoseAction1(input: Action1DiagnoseInput): Promise<IntegrationSetupCheck> {
  if (!input.secretSaved) {
    return fail(S.credentials, 'No Client ID and Client Secret are saved. Paste both from Action1 and save (step 3).');
  }
  if (!input.baseUrlValid) {
    return fail(S.region, 'The saved API base URL is not a valid URL. Use the URL for your region (step 2) and save.');
  }
  try {
    const orgs = await input.probe();
    if (orgs === 0) {
      return fail(
        S.apiCredential,
        'The credentials work, but Action1 shows them no organizations. Give the credentials a role that covers your organizations, for example Enterprise Viewer (step 1), then check again.',
        [S.region, S.credentials],
      );
    }
    return {
      ok: true,
      passedStepIds: [S.apiCredential, S.region, S.credentials],
      failures: [],
      notes: [{ stepId: S.organizations, message: ORGANIZATIONS_UNVERIFIED_NOTE }],
    };
  } catch (e) {
    if (e instanceof DriverRateLimitError) {
      return fail(null, 'Action1 is rate limiting requests right now. Wait a minute and press Check setup again.');
    }
    if (e instanceof Action1AuthError) {
      if (e.stage === 'token') return e.status >= 200 && e.status < 300 ? fail(S.region, WRONG_BASE_URL) : fail(S.apiCredential, BAD_CREDENTIALS);
      if (e.status === 403) {
        return fail(
          S.apiCredential,
          'The credentials work, but their role cannot list organizations. Give them a read-only role such as Enterprise Viewer (step 1), then check again.',
          [S.region, S.credentials],
        );
      }
      return fail(S.apiCredential, BAD_CREDENTIALS);
    }
    if (e instanceof Action1RequestError) {
      // Some OAuth servers answer bad client credentials with 400.
      if (e.stage === 'token' && e.status === 400) return fail(S.apiCredential, BAD_CREDENTIALS);
      if (e.status === 404 || e.status === 405) return fail(S.region, WRONG_BASE_URL);
      return fail(null, 'Action1 did not answer as expected. Try again in a few minutes.');
    }
    // An HTML or other non-JSON body: the host is not the Action1 API.
    if (errorName(e) === 'SyntaxError') return fail(S.region, WRONG_BASE_URL);
    // The host does not resolve or points to a private address.
    if (errorName(e) === 'EgressBlockedError') {
      return fail(S.region, 'Weavestream cannot connect to the saved API base URL. Check the URL for your region (step 2).');
    }
    return fail(null, 'Weavestream could not reach Action1. Check that the server can reach the internet, then try again.');
  }
}
