'use client';

import { useEffect, useState } from 'react';
import { problemMessage, type McpConsentDetails, type McpConsentResult } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Btn, ErrorBanner, RadioOption } from '../../../../components/ui';
import { NotVerifiedTag } from '../../../me/not-verified-tag';

/**
 * Only the authorization server's resume URL on this origin is followed.
 * The browser navigates there with `location.assign`, not a form post: the
 * app CSP (`form-action 'self'`) would block a form whose redirect chain
 * ends at the AI app.
 */
export function resumeUrl(redirectTo: unknown, origin: string): string | null {
  if (typeof redirectTo !== 'string') return null;
  let url: URL;
  try {
    url = new URL(redirectTo, origin);
  } catch {
    return null;
  }
  return url.origin === origin && url.pathname.startsWith('/api/v1/oauth/auth/') ? url.href : null;
}

const assignLocation = (url: string) => window.location.assign(url);

const UNREACHABLE_RETRY = 'Weavestream could not be reached. Check your connection and try again.';
const UNREACHABLE_RELOAD = 'Weavestream could not be reached. Check your connection and reload this page.';

export function ConsentClient({
  uid,
  navigate = assignLocation,
}: {
  uid: string;
  /** Leaves the page for the resume URL; replaceable in tests. */
  navigate?: (url: string) => void;
}) {
  const [details, setDetails] = useState<McpConsentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowWrite, setAllowWrite] = useState(false);
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<McpConsentDetails>(`/oauth-consent/${uid}/details`)
      .then((res) => {
        if (!live) return;
        if (res.ok && res.data) setDetails(res.data);
        else setError(problemMessage(res.problem) ?? 'This connection request could not be loaded.');
      })
      .catch(() => {
        // A network failure is shown, not left on "Loading…"; reloading the
        // page retries while the request is still pending.
        if (live) setError(UNREACHABLE_RELOAD);
      });
    return () => {
      live = false;
    };
  }, [uid]);

  async function decide(decision: 'approve' | 'deny') {
    setPending(decision);
    setError(null);
    let res: Awaited<ReturnType<typeof apiFetch<McpConsentResult>>>;
    try {
      res = await apiFetch<McpConsentResult>(`/oauth-consent/${uid}/${decision}`, {
        method: 'POST',
        body: JSON.stringify(decision === 'approve' ? { allowWrite } : {}),
      });
    } catch {
      // Nothing was decided that the user can see; let them try again.
      setPending(null);
      setError(UNREACHABLE_RETRY);
      return;
    }
    if (res.stepUpCancelled) {
      setPending(null);
      return;
    }
    const next = res.ok ? resumeUrl(res.data?.redirectTo, window.location.origin) : null;
    if (!next) {
      setPending(null);
      setError(problemMessage(res.problem) ?? 'The connection could not be completed. Try again from your AI app.');
      return;
    }
    navigate(next);
  }

  if (error && !details) {
    return <ErrorBanner title="Cannot continue" detail={error} />;
  }
  if (!details) {
    return <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Loading…</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
        <strong>{details.clientName}</strong>
        {!details.clientVerified && (
          <>
            {' '}
            <NotVerifiedTag />
          </>
        )}{' '}
        wants to use Weavestream as <strong>{details.user.email}</strong>, with your permissions.
      </p>

      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '6px 12px',
          fontSize: 12.5,
          padding: 12,
          border: '1px solid var(--line)',
          borderRadius: 6,
          background: 'var(--panel-2)',
        }}
      >
        {details.clientVerified && details.clientHost && (
          <>
            <dt style={{ color: 'var(--muted)' }}>App</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
              {details.clientHost}
            </dd>
          </>
        )}
        <dt style={{ color: 'var(--muted)' }}>Returns to</dt>
        {details.redirectLoopback ? (
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>This computer (localhost)</dd>
        ) : (
          <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
            {details.redirectHost}
          </dd>
        )}
      </dl>
      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        {details.clientVerified ? (
          <>
            Weavestream checked the app and return addresses. The name “{details.clientName}” is
            stated by the app. Only continue if you started this connection yourself.
          </>
        ) : (
          <>
            This app registered itself. Weavestream cannot check its name. Only approve a
            connection you started yourself.
          </>
        )}
      </p>

      <fieldset style={{ margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <legend style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>
          Access
        </legend>
        <RadioOption
          name="mcp-consent-access"
          checked={!allowWrite}
          onChange={() => setAllowWrite(false)}
          label="Read only"
          hint="Find and read companies, assets, articles, domains and password names."
        />
        <RadioOption
          name="mcp-consent-access"
          checked={allowWrite}
          onChange={() => setAllowWrite(true)}
          label="Read and change"
          hint="Also create and update assets and articles. New articles stay hidden from client users."
        />
      </fieldset>

      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        Never available to the app: passwords, TOTP codes and vault notes. It cannot delete
        anything or manage users and permissions. Revoke it any time in Account → AI connections.
      </p>

      {error && <ErrorBanner title="Not connected" detail={error} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
        <Btn kind="outline" size="md" disabled={pending !== null} loading={pending === 'deny'} onClick={() => void decide('deny')}>
          Deny
        </Btn>
        <Btn kind="primary" size="md" disabled={pending !== null} loading={pending === 'approve'} onClick={() => void decide('approve')}>
          Approve
        </Btn>
      </div>
    </div>
  );
}
