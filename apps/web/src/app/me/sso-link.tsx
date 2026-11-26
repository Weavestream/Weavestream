'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isSsoErrorCode, type SsoErrorCode } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { ensureStepUp } from '../../lib/step-up';
import { Btn, Dialog, ErrorBanner, Tag, useToast } from '../../components/ui';

/** Fixed same-origin API path; a full page navigation, never built from input. */
export const SSO_LINK_HREF = '/api/v1/auth/sso/link';

export interface SsoLinkStatus {
  enabled: boolean;
  linked: boolean;
  providerName: string;
}

// What the person sees for the `?sso=` result the link callback returns. Short
// and generic on purpose: the detail stays in the audit log.
const RESULT_MESSAGES: Record<SsoErrorCode, string> = {
  no_account: 'Linking failed. Please try again.',
  not_allowed:
    'That account could not be linked. It may already be linked to another user, or you may already have a linked account. Unlink the current one first, then try again.',
  failed: 'Linking failed. Please try again.',
  expired: 'The link attempt took too long and expired. Please try again.',
};

/**
 * "Single sign-on" in My account → Security. Shown only when the instance has
 * SSO on (the parent decides from `status.enabled`).
 *
 * Linking is a full page navigation to the API: the browser leaves for the
 * identity provider and returns to `/me?sso=<result>`. The API needs a recent
 * step-up first, so the step-up modal runs here before navigating (the same
 * `ensureStepUp` the guarded downloads use); the API checks it again.
 */
export function SsoLink({
  status,
  result = null,
  navigate = (url: string) => window.location.assign(url),
}: {
  status: SsoLinkStatus;
  /** The raw `?sso=` value; anything unknown shows the generic failure. */
  result?: string | null;
  /** Injectable for tests; defaults to a real navigation. */
  navigate?: (url: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = status.providerName;

  async function link() {
    setError(null);
    setBusy(true);
    try {
      const ok = await ensureStepUp();
      if (!ok) return; // declined the prompt; nothing to report
      navigate(SSO_LINK_HREF);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setConfirming(false);
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch('/auth/sso/link', { method: 'DELETE' });
      if (res.status === 409) {
        setError(
          'Set a password before unlinking, or this account would have no way to sign in.',
        );
        return;
      }
      if (!res.ok) {
        setError(`Could not unlink your ${name} account.`);
        return;
      }
      toast.push(`Unlinked your ${name} account.`, 'ok');
      router.refresh();
    } catch {
      setError(`Could not unlink your ${name} account.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
      {result === 'linked' && (
        <div
          role="status"
          style={{
            padding: '8px 12px',
            border: '1px solid var(--line)',
            borderRadius: 6,
            background: 'var(--panel-2)',
            fontSize: 13,
            color: 'var(--text)',
          }}
        >
          Your {name} account is now linked. You can sign in with it.
        </div>
      )}
      {result !== null && result !== '' && result !== 'linked' && (
        <ErrorBanner title={RESULT_MESSAGES[isSsoErrorCode(result) ? result : 'failed']} />
      )}
      {error && <ErrorBanner title={error} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{name}</span>
        {status.linked ? <Tag tone="ok">linked</Tag> : <Tag tone="warn">not linked</Tag>}
      </div>

      {status.linked ? (
        <div>
          <Btn kind="outline" size="sm" loading={busy} onClick={() => setConfirming(true)}>
            Unlink
          </Btn>
        </div>
      ) : (
        <div>
          <Btn kind="primary" size="sm" loading={busy} onClick={() => void link()}>
            Link {name} account
          </Btn>
        </div>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Unlink single sign-on"
        width={440}
        footer={
          <>
            <Btn kind="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Btn>
            <Btn kind="danger" onClick={() => void unlink()}>
              Unlink
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Unlink your <strong>{name}</strong> account? You will no longer be able to sign in with it
          until you link it again. Your password still works.
        </p>
      </Dialog>
    </div>
  );
}
