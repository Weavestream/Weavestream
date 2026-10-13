import type { IntegrationSetupCheck } from '@weavestream/shared';
import { DriverAuthError, type DriverDiagnoseInput, type IntegrationContext } from '../integration-driver.js';
import { OAuthTokenError, exchangeAuthorizationCode, oauthFetch } from '../../oauth/oauth-token.js';
import {
  API_DISABLED_REASONS,
  DIRECTORY,
  GOOGLE_WORKSPACE_OAUTH,
  LICENSING,
  RATE_LIMIT_REASONS,
  REPORTS,
  apiName,
  errorReasons,
} from './google-workspace.driver.js';
import { GOOGLE_SETUP_STEP as S } from './google-workspace.setup-guide.js';

/**
 * Check setup for Google Workspace. Every outcome is a fixed message that
 * names a guide step; Google's own error text never reaches the client.
 * Read-only: the client check posts a dummy code that can never be
 * redeemed, the connection check issues one cheap GET per API.
 */

export type Failure = IntegrationSetupCheck['failures'][number];

const UNREACHABLE: Failure = {
  stepId: null,
  message: 'Weavestream could not reach Google. Check that the server can reach the internet, then try again.',
};
const RATE_LIMITED: Failure = {
  stepId: null,
  message: 'Google is rate limiting requests right now. Wait a minute and press Check setup again.',
};

function result(passed: string[], failures: Failure[]): IntegrationSetupCheck {
  return { ok: failures.length === 0, passedStepIds: passed, failures };
}

/** Fixed note: a dummy code cannot prove the redirect URI; a real connect does. */
export const REDIRECT_UNVERIFIED_NOTE = 'Redirect URI is confirmed on the first successful connect.';

// A syntactically valid PKCE verifier; the dummy code fails before it is used.
const DUMMY_VERIFIER = 'weavestream-setup-check-weavestream-setup-check';

/**
 * Verify the instance OAuth client id and secret without any customer
 * token. The redirect URI (client step) stays unverified: Google rejects
 * the dummy code before it compares the redirect URI.
 */
export async function diagnoseGoogleClient(
  input: Extract<DriverDiagnoseInput, { mode: 'client' }>,
): Promise<IntegrationSetupCheck> {
  try {
    await exchangeAuthorizationCode(
      GOOGLE_WORKSPACE_OAUTH,
      input.oauthClient,
      { code: 'weavestream-setup-check', codeVerifier: DUMMY_VERIFIER, redirectUri: input.redirectUri },
      input.http,
      input.correlationId,
    );
    // A dummy code is never redeemable; if Google accepted it, the client is still proven.
    return result([S.project, S.client, S.credentials], []);
  } catch (e) {
    if (!(e instanceof OAuthTokenError)) return result([], [UNREACHABLE]);
    switch (e.code) {
      case 'invalid_grant':
        // Expected: the client id and secret were accepted; the redirect URI was not checked.
        return { ...result([S.project, S.credentials], []), notes: [{ stepId: S.client, message: REDIRECT_UNVERIFIED_NOTE }] };
      case 'invalid_client':
      case 'unauthorized_client':
        return result([], [{
          stepId: S.credentials,
          message: 'Google does not recognise this client ID and secret. Copy both again from the OAuth client (step 5) and save them.',
        }]);
      case 'redirect_uri_mismatch':
        return result([S.project, S.credentials], [{
          stepId: S.client,
          message: 'The redirect URI is not registered on the OAuth client. Add the exact redirect URI from step 5 under Authorized redirect URIs.',
        }]);
      default:
        if (e.status === 429) return result([], [RATE_LIMITED]);
        return result([], [{
          stepId: S.credentials,
          message: `Google rejected the OAuth client (HTTP ${e.status}). Check the client ID and secret (steps 5 and 6).`,
        }]);
    }
  }
}

interface Probe {
  url: string;
  /** Present for the probe that reads the tenant id the others need. */
  customer?: true;
}

function reportDate(): string {
  return new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
}

/** Map one probe response (or thrown error) to a failure, or null when it passed. */
export async function probeFailure(url: string, res: Response, forbidden?: string): Promise<Failure | null> {
  if (res.ok) return null;
  const reasons = await errorReasons(res);
  const has = (...codes: string[]) => codes.some((c) => reasons.has(c));
  const api = apiName(url);
  if (res.status === 429 || [...reasons].some((r) => RATE_LIMIT_REASONS.has(r))) return RATE_LIMITED;
  if ([...reasons].some((r) => API_DISABLED_REASONS.has(r))) {
    return { stepId: S.apis, message: `The ${api} is not enabled in the Google Cloud project. Enable it (step 2), wait a few minutes, then check again.` };
  }
  if (has('admin_policy_enforced')) {
    return { stepId: S.trust, message: 'The customer\'s Google Admin console blocks this app. Mark the client ID as Trusted (step 8), then reconnect.' };
  }
  if (has('org_internal')) {
    return { stepId: S.consent, message: 'The consent screen is limited to your own organisation. Set Audience to External and publish the app (step 3).' };
  }
  if (has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientScopes')) {
    return { stepId: S.connect, message: `Not every permission was approved for the ${api}. Press Reconnect and tick every permission (step 7).` };
  }
  if (forbidden && res.status === 403) return { stepId: S.connect, message: forbidden };
  if (res.status === 401 || res.status === 403) {
    return { stepId: S.connect, message: `The connected account has no admin access to the ${api}. Reconnect with a super admin, or a delegated admin who can read this data (step 7).` };
  }
  return { stepId: null, message: `Google returned an unexpected error for the ${api} (HTTP ${res.status}). Try again later.` };
}

/** Probe a connected integration: one cheap GET per Google API. */
export async function diagnoseGoogleConnection(ctx: IntegrationContext): Promise<IntegrationSetupCheck> {
  const failures: Failure[] = [];
  const probes: Probe[] = [
    { url: `${DIRECTORY}/customers/my_customer`, customer: true },
    { url: `${LICENSING}/product/Google-Apps/users?maxResults=1` },
    { url: `${REPORTS}/usage/dates/${reportDate()}?parameters=accounts:used_quota_in_mb` },
  ];
  let customerId: string | null = null;
  let answered = 0;
  for (const probe of probes) {
    let url = probe.url;
    if (url.startsWith(LICENSING)) {
      // Licensing needs the tenant id; without it the probe cannot run.
      if (!customerId) continue;
      url = `${url}&customerId=${encodeURIComponent(customerId)}`;
    }
    let res: Response;
    try {
      res = await oauthFetch(ctx, GOOGLE_WORKSPACE_OAUTH, url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        serviceName: 'Google Workspace',
      });
    } catch (e) {
      // Token problems apply to every probe: stop at the first one.
      return result([], [tokenFailure(e)]);
    }
    const failure = await probeFailure(url, res);
    if (failure) {
      if (!failures.some((f) => f.message === failure.message)) failures.push(failure);
      continue;
    }
    answered += 1;
    if (probe.customer) {
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      customerId = typeof body?.id === 'string' ? body.id : null;
    }
  }
  const failed = new Set(failures.map((f) => f.stepId));
  // A token was issued, so the project, consent screen and client work.
  const passed: string[] = [S.project, S.consent, S.client, S.credentials];
  if (!failed.has(S.apis)) passed.push(S.apis);
  if (!failed.has(S.connect)) passed.push(S.connect);
  // A disabled API or an unanswered probe (stepId null, e.g. rate limited)
  // proves nothing about scopes or trust, so those wait for a clean answer.
  const unverified = failed.has(null);
  if (!unverified && !failed.has(S.connect) && !failed.has(S.apis)) passed.push(S.scopes);
  // Trust needs at least one API that actually answered through the customer's policy.
  if (!unverified && answered > 0 && !failed.has(S.trust)) passed.push(S.trust);
  return result(passed, failures);
}

export function tokenFailure(e: unknown): Failure {
  if (e instanceof OAuthTokenError) {
    if (e.code === 'admin_policy_enforced') {
      return { stepId: S.trust, message: 'The customer\'s Google Admin console blocks this app. Mark the client ID as Trusted (step 8), then reconnect.' };
    }
    if (e.code === 'org_internal') {
      return { stepId: S.consent, message: 'The consent screen is limited to your own organisation. Set Audience to External and publish the app (step 3).' };
    }
    if (e.status === 429) return RATE_LIMITED;
    return { stepId: S.connect, message: `Google refused to refresh the connection (HTTP ${e.status}). Press Reconnect (step 7).` };
  }
  if (e instanceof DriverAuthError) {
    // invalid_grant / invalid_client, already mapped to fixed text by getOAuthAccessToken.
    return /OAuth app credentials|not configured/.test(e.message)
      ? { stepId: S.credentials, message: 'Google rejected the OAuth app credentials. Check the client ID and secret on the App tab (step 6).' }
      : { stepId: S.connect, message: 'The Google connection was revoked or has expired (for example after 6 months unused). Press Reconnect (step 7).' };
  }
  return UNREACHABLE;
}
