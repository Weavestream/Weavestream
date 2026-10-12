import { MICROSOFT_REPORT_SETTING, type IntegrationSetupCheck } from '@weavestream/shared';
import { DriverRateLimitError, type DriverDiagnoseInput, type IntegrationContext } from '../integration-driver.js';
import {
  OAuthTokenError,
  adminConsentTokenMessage,
  appTokenClaims,
  mintClientCredentialsToken,
  parseStoredAdminConsent,
} from '../../oauth/oauth-token.js';
import {
  GRAPH,
  GraphAccessError,
  MICROSOFT_365_OAUTH,
  MICROSOFT_REQUIRED_PERMISSIONS,
  P1_CODES,
  REPORT_SETTINGS_WRITE,
  canReadReportSettings,
  getOrganization,
  graphGet,
  intuneUnavailableMessage,
  readReportConcealment,
} from './microsoft-365.graph.js';
import { MICROSOFT_SETUP_STEP as S } from './microsoft-365.setup-guide.js';

/**
 * Check setup for Microsoft 365. Every outcome is a fixed message naming a
 * guide step; Microsoft's error text never reaches the client (only AADSTS
 * numbers and Graph error codes are read, from
 * learn.microsoft.com/entra/identity-platform/reference-error-codes).
 * Read-only: token requests and GETs.
 */

type Failure = IntegrationSetupCheck['failures'][number];
type Note = NonNullable<IntegrationSetupCheck['notes']>[number];

const UNREACHABLE: Failure = {
  stepId: null,
  message: 'Weavestream could not reach Microsoft. Check that the server can reach the internet, then try again.',
};
const RATE_LIMITED: Failure = {
  stepId: null,
  message: 'Microsoft is rate limiting requests right now. Wait a minute and press Check setup again.',
};

function result(passed: string[], failures: Failure[], notes: Note[] = []): IntegrationSetupCheck {
  return { ok: failures.length === 0, passedStepIds: passed, failures, ...(notes.length > 0 ? { notes } : {}) };
}

/** An Intune read failure that is not an identified licence or permission signal. */
export const INTUNE_UNREADABLE_NOTE =
  'Intune devices could not be read right now, so a sync may fail on computers and mobile devices. Try Check setup again later.';

export const SECRET_UNVERIFIED_NOTE =
  'Save your Directory (tenant) ID on the Microsoft app card to let Check setup verify the client secret.';

/** Map a refused client-credentials request to a failure, or null when the client itself was accepted. */
function clientFailure(e: OAuthTokenError): Failure | null {
  switch (e.aadsts) {
    case 7000215:
      return { stepId: S.secret, message: 'Microsoft rejected the client secret (AADSTS7000215). Copy the secret Value (not the Secret ID) again (step 3) and save it.' };
    case 7000222:
      return { stepId: S.secret, message: 'The client secret has expired (AADSTS7000222). Create a new secret (step 3) and save it.' };
    case 700016:
      return { stepId: S.credentials, message: 'Microsoft does not know this Application (client) ID in that directory (AADSTS700016). Copy it again from the app overview (step 1).' };
    case 50194:
      return { stepId: S.register, message: 'The app is not multi-tenant (AADSTS50194). Set Supported account types to Accounts in any organizational directory (step 1).' };
    case 7000112:
      return { stepId: S.register, message: 'The app is disabled (AADSTS7000112). Enable it in Entra, then check again.' };
    case 90002:
      return { stepId: S.credentials, message: 'Microsoft cannot find that Directory (tenant) ID (AADSTS90002). Copy it again from the app overview (step 1).' };
    default:
      if (e.status === 429) return RATE_LIMITED;
      return null;
  }
}

/**
 * Verify the instance app without any customer. With the operator's own
 * tenant id a client-credentials token proves the client id and secret.
 * Without it the request goes to `organizations`, which Entra rejects; the
 * AADSTS number still exposes a wrong secret, an unknown app or a
 * single-tenant app, and anything else leaves the secret unverified.
 */
export async function diagnoseMicrosoftClient(
  input: Extract<DriverDiagnoseInput, { mode: 'client' }>,
): Promise<IntegrationSetupCheck> {
  const tenant = input.homeTenantId ?? 'organizations';
  try {
    await mintClientCredentialsToken(MICROSOFT_365_OAUTH, input.oauthClient, tenant, input.http, input.correlationId);
    return result([S.register, S.secret, S.credentials], []);
  } catch (e) {
    if (e instanceof DriverRateLimitError) return result([], [RATE_LIMITED]);
    if (!(e instanceof OAuthTokenError)) return result([], [UNREACHABLE]);
    const failure = clientFailure(e);
    if (failure) return result(failure.stepId === S.secret ? [S.register, S.credentials] : [], [failure]);
    if (!input.homeTenantId) {
      return result([], [], [{ stepId: S.secret, message: SECRET_UNVERIFIED_NOTE }]);
    }
    return result([], [{ stepId: S.credentials, message: `Microsoft refused the token request (HTTP ${e.status}). Check the client ID, secret and Directory (tenant) ID (steps 1 to 4).` }]);
  }
}

export const OPTIONAL_WRITE_NOTE =
  'The optional ReportSettings.ReadWrite.All is not granted, so the report names setting is changed by hand in the Microsoft 365 admin center (the integration page lists the steps).';

export function missingPermissionsMessage(missing: string[]): string {
  return `Not granted in this tenant: ${missing.join(', ')}. Add any of these that are missing on the app (step 2), then a Global Administrator presses Reconnect and approves again.`;
}

/** Probe a connected tenant: a fresh token, its roles, the tenant id, then cheap GETs for licence-dependent data. */
export async function diagnoseMicrosoftConnection(ctx: IntegrationContext): Promise<IntegrationSetupCheck> {
  const stored = parseStoredAdminConsent(ctx.secret);
  if (!stored) {
    return result([], [{ stepId: S.connect, message: 'This tenant is not connected. Press Reconnect on its row of the Connections tab (step 5).' }]);
  }
  if (!ctx.oauthClient) {
    return result([], [{ stepId: S.credentials, message: 'The Microsoft app is not configured. Save it on the App tab (step 4).' }]);
  }
  let roles: string[] | null;
  try {
    const tokens = await mintClientCredentialsToken(MICROSOFT_365_OAUTH, ctx.oauthClient, stored.tenantId, ctx.http, ctx.correlationId);
    roles = appTokenClaims(tokens.access_token)?.roles ?? null;
  } catch (e) {
    if (e instanceof DriverRateLimitError) return result([], [RATE_LIMITED]);
    if (!(e instanceof OAuthTokenError)) return result([], [UNREACHABLE]);
    const mapped = adminConsentTokenMessage(e);
    const step = e.aadsts === 7000215 || e.aadsts === 7000222 ? S.secret : mapped.reconnect ? S.connect : S.credentials;
    return result([], [{ stepId: step, message: mapped.message }]);
  }

  const failures: Failure[] = [];
  const notes: Note[] = [];
  const passed: string[] = [S.register, S.secret, S.credentials];
  if (roles === null) {
    notes.push({ stepId: S.permissions, message: 'Microsoft returned a token Weavestream cannot read, so granted permissions were not compared.' });
  } else {
    const missing = MICROSOFT_REQUIRED_PERMISSIONS.filter((p) => !roles!.includes(p));
    if (missing.length > 0) failures.push({ stepId: S.permissions, message: missingPermissionsMessage(missing) });
    else passed.push(S.permissions);
    if (!roles.includes(REPORT_SETTINGS_WRITE)) {
      notes.push({ stepId: S.names, message: OPTIONAL_WRITE_NOTE });
    }
  }

  const probe = async <T>(load: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    try {
      return { ok: true, value: await load() };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const org = await probe(() => getOrganization(ctx));
  if (!org.ok) {
    failures.push(org.error instanceof DriverRateLimitError ? RATE_LIMITED : { stepId: S.connect, message: 'Weavestream could not read the tenant (Organization.Read.All). Press Reconnect (step 5).' });
  } else if (org.value.id.toLowerCase() !== stored.tenantId) {
    failures.push({ stepId: S.connect, message: 'The token belongs to a different tenant than the connected one. Press Reconnect (step 5).' });
  } else {
    passed.push(S.connect);
  }

  const p1 = await probe(() => graphGet(ctx, `${GRAPH}/users?$select=id,signInActivity&$top=1`, 'sign-in activity'));
  if (!p1.ok) {
    const needsP1 = p1.error instanceof GraphAccessError && p1.error.graphCode !== null && P1_CODES.has(p1.error.graphCode);
    notes.push({
      stepId: S.connect,
      message: needsP1
        ? 'Last sign-in and MFA registration need Entra ID P1; those rows show Not available for this tenant.'
        : 'Sign-in activity could not be read (AuditLog.Read.All); those rows show Not available.',
    });
  }

  const devices = await probe(() => graphGet(ctx, `${GRAPH}/deviceManagement/managedDevices?$select=id&$top=1`, 'Intune devices'));
  if (!devices.ok) {
    notes.push({ stepId: S.layouts, message: intuneUnavailableMessage(devices.error, roles) ?? INTUNE_UNREADABLE_NOTE });
  }

  const readable = roles === null || canReadReportSettings(roles);
  const concealed = readable ? await probe(() => readReportConcealment(ctx)) : ({ ok: false, error: null } as const);
  if (!concealed.ok) {
    notes.push({
      stepId: S.names,
      message: readable
        ? `The report setting "${MICROSOFT_REPORT_SETTING.label}" could not be read right now. Try Check setup again later.`
        : `The report setting "${MICROSOFT_REPORT_SETTING.label}" could not be read (optional ReportSettings.Read.All not granted).`,
    });
  } else if (concealed.value) {
    notes.push({
      stepId: S.names,
      message: `"${MICROSOFT_REPORT_SETTING.label}" is on in this tenant, so mailbox and OneDrive storage cannot be matched to people.${stored.reportNames ? '' : ' Choose on the Connections tab whether to show real names.'}`,
    });
  }
  if (stored.reportNames) passed.push(S.names);
  return result(passed, failures, notes);
}
