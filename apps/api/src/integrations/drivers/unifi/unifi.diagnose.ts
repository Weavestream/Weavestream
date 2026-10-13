import type { IntegrationSetupCheck } from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError } from '../integration-driver.js';
import { UNIFI_SETUP_STEP as S } from './unifi.setup-guide.js';

/** A UniFi 401/403. Keeps the DriverAuthError name and message. */
export class UniFiAuthError extends DriverAuthError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Any other non-OK UniFi response; carries only the status. */
export class UniFiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'UniFiRequestError';
  }
}

export interface UniFiDiagnoseInput {
  /** An API key is saved. */
  secretSaved: boolean;
  /** The saved API base URL parses (or is left at the default). */
  baseUrlValid: boolean;
  /** One page of the Site Manager device list; resolves to the number of consoles on it. */
  probe: () => Promise<number>;
}

const fail = (stepId: string | null, message: string, passedStepIds: string[] = []): IntegrationSetupCheck => ({
  ok: false,
  passedStepIds,
  failures: [{ stepId, message }],
});

/** By name: `res.json()` can throw a SyntaxError from another realm, which fails `instanceof`. */
const errorName = (e: unknown): string => (typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '');

export const HOSTS_UNVERIFIED_NOTE = 'The key sees your consoles. Check setup does not check mappings: map each console to a company on Organizations.';

const WRONG_BASE_URL ='The API Base URL does not point to the UniFi Site Manager API. Set it back to the default (step 2) and save.';

/**
 * Check setup for UniFi Site Manager: one read-only probe (the first page
 * of the device list, which is grouped by console). Every outcome is a
 * fixed message naming a guide step; UniFi's own error text never reaches
 * the client.
 */
export async function diagnoseUniFi(input: UniFiDiagnoseInput): Promise<IntegrationSetupCheck> {
  if (!input.secretSaved) {
    return fail(S.credentials, 'No API key is saved. Paste the key from UniFi Site Manager and save (step 2).');
  }
  if (!input.baseUrlValid) {
    return fail(S.credentials, 'The saved API Base URL is not a valid URL. Set it back to the default (step 2) and save.');
  }
  try {
    const consoles = await input.probe();
    if (consoles === 0) {
      return fail(
        S.apiKey,
        'The key works, but UniFi shows it no consoles. Create the key with the UI account that is Owner or Super Admin of your consoles (step 1), then check again.',
        [S.credentials],
      );
    }
    // The probe proves consoles are visible, not that any is mapped; the
    // driver cannot see saved mappings, so the step stays unverified.
    return {
      ok: true,
      passedStepIds: [S.apiKey, S.credentials],
      failures: [],
      notes: [{ stepId: S.hosts, message: HOSTS_UNVERIFIED_NOTE }],
    };
  } catch (e) {
    if (e instanceof DriverRateLimitError) {
      return fail(null, 'UniFi is rate limiting requests right now. Wait a minute and press Check setup again.');
    }
    if (e instanceof UniFiAuthError) {
      if (e.status === 403) {
        return fail(
          S.apiKey,
          'UniFi accepts this API key, but its account has no permission to list devices. Create the key with the UI account that is Owner or Super Admin of your consoles (step 1), then check again.',
        );
      }
      return fail(
        S.apiKey,
        'UniFi does not accept this API key. It may be mistyped or deleted. Create a new key (step 1) and paste it again (step 2).',
      );
    }
    if (e instanceof UniFiRequestError) {
      if (e.status === 404 || e.status === 405) return fail(S.credentials, WRONG_BASE_URL);
      return fail(null, 'UniFi did not answer as expected. Try again in a few minutes.');
    }
    // An HTML or other non-JSON body: the host is not the Site Manager API.
    if (errorName(e) === 'SyntaxError') return fail(S.credentials, WRONG_BASE_URL);
    // The host does not resolve or points to a private address.
    if (errorName(e) === 'EgressBlockedError') {
      return fail(S.credentials, 'Weavestream cannot connect to the saved API Base URL. Set it back to the default (step 2) and save.');
    }
    return fail(null, 'Weavestream could not reach UniFi Site Manager. Check that the server can reach the internet, then try again.');
  }
}
