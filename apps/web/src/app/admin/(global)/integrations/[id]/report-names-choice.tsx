'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MicrosoftReportNames, MicrosoftReportNamesAction } from '@weavestream/shared';
import { MICROSOFT_REPORT_SETTING, MICROSOFT_REPORT_SETTING_MANUAL_STEPS, problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Tag, useToast } from '../../../../../components/ui';

const S = MICROSOFT_REPORT_SETTING;

export const REPORT_NAMES_QUESTION = 'Show real names in Microsoft usage reports so storage can be matched to users?';

/** What "show" changes, stated precisely (shown in the prompt and the confirmation). */
export const SHOW_EXPLANATION =
  `Weavestream turns off "${S.label}" (${S.path}) for this whole tenant ` +
  `(${S.graph}: true to false). Every Microsoft 365 usage report of this tenant then shows real user names, ` +
  'group names and site URLs: in the Microsoft 365 admin center, Microsoft Graph, Power BI and the Teams admin center. ' +
  'Anyone in the tenant who can read usage reports (for example Global, Exchange, SharePoint or Teams administrators and ' +
  'Reports Readers) sees them, and so does Weavestream. Microsoft records the change in the tenant audit log. ' +
  'You can turn concealment back on here, or with the same checkbox in the admin center.';

export const KEEP_EXPLANATION =
  'Keeping names hidden changes nothing in the tenant. Mailbox and OneDrive storage then show as hidden by the tenant\'s report privacy setting.';

export const MANUAL_INTRO =
  'This tenant did not grant the optional ReportSettings.ReadWrite.All, so Weavestream cannot change this setting. To change it by hand:';

export const CONCEAL_EXPLANATION =
  `Weavestream turns "${S.label}" (${S.path}) back on for this whole tenant (${S.graph}: false to true). ` +
  'Usage reports hide user, group and site names again, for everyone in the tenant and for Weavestream; storage is no longer matched to people.';

function valueText(concealed: boolean | null): string {
  if (concealed === null) return 'could not be read';
  return concealed ? 'On (names hidden)' : 'Off (real names shown)';
}

/**
 * Microsoft 365 only: the admin decides whether the customer tenant shows
 * real names in usage reports. The current value is read from the tenant
 * before asking; "show" and "turn concealment back on" each change that one
 * setting once, after a confirmation that names it; "keep" changes nothing.
 */
export function ReportNamesChoice({
  integrationId,
  connectionId,
  choice: initialChoice,
}: {
  integrationId: string;
  /** The client tenant (connection) the choice belongs to. */
  connectionId: string;
  choice: 'shown' | 'hidden' | null;
}) {
  const toast = useToast();
  const [state, setState] = useState<MicrosoftReportNames | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<MicrosoftReportNamesAction['action'] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<MicrosoftReportNames>(`/admin/integrations/${integrationId}/connections/${connectionId}/microsoft/report-names`);
      if (res.ok && res.data) {
        setState(res.data);
        setLoadFailed(false);
        return;
      }
    } catch {
      // apiFetch rethrows network failures: show the load-failed state.
    }
    setLoadFailed(true);
  }, [integrationId, connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: MicrosoftReportNamesAction['action']) {
    if (action === 'show' && !window.confirm(`Show real names in usage reports?\n\n${SHOW_EXPLANATION}`)) return;
    if (action === 'conceal' && !window.confirm(`Turn concealment back on?\n\n${CONCEAL_EXPLANATION}`)) return;
    setBusy(action);
    let res: Awaited<ReturnType<typeof apiFetch<MicrosoftReportNames>>>;
    try {
      res = await apiFetch<MicrosoftReportNames>(`/admin/integrations/${integrationId}/connections/${connectionId}/microsoft/report-names`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
    } catch {
      toast.push('Could not change the report setting.', 'danger');
      return;
    } finally {
      setBusy(null);
    }
    if (!res.ok || !res.data) {
      if (!res.stepUpCancelled) toast.push(problemMessage(res.problem) ?? 'Could not change the report setting.', 'danger');
      return;
    }
    setState(res.data);
    setMessage(res.data.message ?? null);
  }

  const choice = state?.choice ?? initialChoice;
  const concealed = state?.concealed ?? null;

  return (
    <section aria-label="Usage report names" style={boxStyle}>
      <h4 style={titleStyle}>Usage report names</h4>
      <p style={textStyle}>
        Setting: <strong>{S.path} &gt; &quot;{S.label}&quot;</strong>
      </p>
      {loadFailed ? (
        <Tag tone="danger">Could not load the report setting. Reload to try again.</Tag>
      ) : !state ? (
        <p style={mutedStyle}>Reading the current value from the tenant…</p>
      ) : (
        <>
          <p style={textStyle}>
            Current value in this tenant: <strong>{valueText(concealed)}</strong>
          </p>
          {state.readError && <p style={dangerStyle}>{state.readError}</p>}
          {choice === null ? (
            <>
              <p style={{ ...textStyle, fontWeight: 600 }}>{REPORT_NAMES_QUESTION}</p>
              <p style={mutedStyle}>Yes: {SHOW_EXPLANATION}</p>
              <p style={mutedStyle}>No: {KEEP_EXPLANATION}</p>
            </>
          ) : choice === 'shown' ? (
            <p style={mutedStyle}>You chose to show real names. To undo it: {CONCEAL_EXPLANATION}</p>
          ) : (
            <p style={mutedStyle}>You chose to keep names hidden. You can change this at any time. Yes: {SHOW_EXPLANATION}</p>
          )}
          {!state.canChange && (
            <div>
              <p style={textStyle}>{MANUAL_INTRO}</p>
              <ol style={{ ...textStyle, paddingLeft: 20 }}>
                {MICROSOFT_REPORT_SETTING_MANUAL_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {state.canChange && concealed !== false && (
              <Btn kind="primary" size="sm" onClick={() => void act('show')} loading={busy === 'show'} disabled={busy !== null || concealed === null}>
                Yes, show real names (turn the setting off)
              </Btn>
            )}
            {choice === null && concealed !== false && (
              <Btn kind="outline" size="sm" onClick={() => void act('keep')} loading={busy === 'keep'} disabled={busy !== null}>
                No, keep names hidden (change nothing)
              </Btn>
            )}
            {choice === null && concealed === false && (
              <Btn kind="primary" size="sm" onClick={() => void act('keep')} loading={busy === 'keep'} disabled={busy !== null}>
                Keep real names shown (change nothing)
              </Btn>
            )}
            {state.canChange && concealed === false && (
              <Btn kind="outline" size="sm" onClick={() => void act('conceal')} loading={busy === 'conceal'} disabled={busy !== null}>
                Turn concealment back on
              </Btn>
            )}
          </div>
          {message && (
            <p role="status" style={{ ...textStyle, color: 'var(--ok)' }}>
              {message}
            </p>
          )}
        </>
      )}
    </section>
  );
}

const boxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  border: '1px solid var(--line)',
  borderRadius: 6,
  background: 'var(--panel-2)',
};
const titleStyle: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text)' };
const textStyle: React.CSSProperties = { margin: 0, fontSize: 13, color: 'var(--text)', overflowWrap: 'anywhere' };
const mutedStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--muted)' };
const dangerStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--danger)' };
