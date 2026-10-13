import type { IntegrationContext } from '../integration-driver.js';
import { oauthFetch } from '../../oauth/oauth-token.js';
import { GRAPH, GraphAccessError, GraphRequestError, MICROSOFT_365_OAUTH, graphErrorCode } from './microsoft-365.graph.js';

/**
 * The ONLY write Weavestream makes to a Microsoft 365 tenant:
 * PATCH /admin/reportSettings { displayConcealedNames }, which is the admin
 * center checkbox "Conceal user, group, and site names in all reports"
 * (Settings > Org settings > Services > Reports). Called solely from the
 * explicit, step-up gated, audited admin action in
 * `MicrosoftReportNamesService`; the driver and the sync never import this
 * module (the GET-only spec asserts it).
 */
export async function writeReportConcealment(ctx: IntegrationContext, conceal: boolean): Promise<void> {
  const res = await oauthFetch(ctx, MICROSOFT_365_OAUTH, `${GRAPH}/admin/reportSettings`, {
    method: 'PATCH',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayConcealedNames: conceal }),
    redirect: 'error',
    serviceName: 'Microsoft 365',
  });
  if (res.ok) return;
  const code = await graphErrorCode(res);
  if (res.status === 401 || res.status === 403) {
    throw new GraphAccessError(
      'Microsoft refused the change: ReportSettings.ReadWrite.All is not granted in this tenant. A Global Administrator presses Reconnect to approve it, then try again.',
      code,
    );
  }
  throw new GraphRequestError(`Microsoft did not accept the change (HTTP ${res.status}). Try again later.`, res.status, code);
}
