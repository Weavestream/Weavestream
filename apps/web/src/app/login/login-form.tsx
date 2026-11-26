'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isSsoErrorCode, type SsoConfig, type SsoErrorCode } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { Btn, btnStyle, ErrorBanner, Field, Input } from '../../components/ui';
import { nextQuery, safeNextPath } from '../../lib/safe-next-path';

interface LoginResponse {
  mfaSetupRequired: boolean;
  mfaChallengeRequired: boolean;
  user: { id: string; email: string };
}

// Short and generic on purpose: the detail stays in the server log.
const SSO_ERROR_MESSAGES: Record<SsoErrorCode, string> = {
  no_account: 'No Weavestream account matches that sign-in. Ask an administrator for access.',
  not_allowed: 'That account is not allowed to sign in here.',
  failed: 'Single sign-on failed. Please try again.',
  expired: 'The sign-in took too long and expired. Please try again.',
};

/** Fixed same-origin API path; a full page navigation, never built from input. */
const SSO_LOGIN_HREF = '/api/v1/auth/sso/login';

/**
 * `next`: an already-validated return path (see `safeNextPath`), or null.
 * `ssoError`: the raw `?sso_error=` value; anything unknown shows the
 * generic failure message.
 */
export default function LoginForm({
  next = null,
  ssoError = null,
}: {
  next?: string | null;
  ssoError?: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sso, setSso] = useState<SsoConfig | null>(null);
  const [showLocal, setShowLocal] = useState(false);

  useEffect(() => {
    let live = true;
    void apiFetch<SsoConfig>('/auth/sso/config').then((res) => {
      if (live && res.ok && res.data?.enabled === true) setSso(res.data);
    });
    return () => {
      live = false;
    };
  }, []);

  const ssoMessage =
    ssoError === null || ssoError === ''
      ? null
      : SSO_ERROR_MESSAGES[isSsoErrorCode(ssoError) ? ssoError : 'failed'];
  const localHidden = sso !== null && !sso.localLoginEnabled && !showLocal;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      if (res.status === 429) setError('Too many attempts. Try again later.');
      else setError('Invalid credentials.');
      return;
    }
    if (res.data.mfaSetupRequired) router.push(`/mfa/setup${nextQuery(next)}`);
    else if (res.data.mfaChallengeRequired) router.push(`/mfa/challenge${nextQuery(next)}`);
    else router.push(safeNextPath(next) ?? '/');
  }

  const ssoPart = (
    <>
      {ssoMessage && <ErrorBanner title={ssoMessage} />}
      {sso && (
        <a
          href={SSO_LOGIN_HREF}
          style={{ ...btnStyle({ kind: 'primary', size: 'md' }), height: 36, width: '100%' }}
        >
          Sign in with {sso.providerName}
        </a>
      )}
    </>
  );

  if (localHidden) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {ssoPart}
        <Btn
          type="button"
          kind="ghost"
          size="sm"
          onClick={() => setShowLocal(true)}
          style={{ alignSelf: 'center', color: 'var(--muted)', fontWeight: 400 }}
        >
          Use a local account
        </Btn>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {ssoPart}
      {sso && (
        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
          or sign in with a local account
        </div>
      )}
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password" error={error ?? undefined}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Btn
          type="submit"
          kind="primary"
          size="md"
          loading={pending}
          style={{ marginTop: 4, height: 36, justifyContent: 'center' }}
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </Btn>
      </form>
    </div>
  );
}
