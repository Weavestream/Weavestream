'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../lib/api';
import { Btn, Field, Input } from '../../../components/ui';

interface EnrollResponse {
  secret: string;
  otpauthUrl: string;
}

export default function MfaSetupClient() {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch<EnrollResponse>('/auth/mfa/enroll', { method: 'POST' });
      if (res.ok && res.data) {
        setSecret(res.data.secret);
        setOtpauthUrl(res.data.otpauthUrl);
      } else {
        setError('Could not start MFA enrollment.');
      }
    })();
  }, []);

  async function onVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await apiFetch('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    setPending(false);
    if (!res.ok) {
      setError('Invalid code. Try again.');
      return;
    }
    router.push('/');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 5,
          padding: 12,
          fontSize: 11.5,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-2)',
          wordBreak: 'break-all',
        }}
      >
        {otpauthUrl ? (
          <>
            <div style={{ color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              otpauth url
            </div>
            <div style={{ color: 'var(--text)' }}>{otpauthUrl}</div>
            {secret && (
              <div style={{ marginTop: 10 }}>
                <span style={{ color: 'var(--muted)' }}>secret: </span>
                <span>{secret}</span>
              </div>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--muted)' }}>Generating secret…</span>
        )}
      </div>
      <form onSubmit={onVerify} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="6-digit code" htmlFor="totp" error={error ?? undefined}>
          <Input
            id="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ letterSpacing: '0.4em', fontFamily: 'var(--font-mono)', textAlign: 'center' }}
          />
        </Field>
        <Btn
          type="submit"
          kind="primary"
          size="md"
          loading={pending}
          disabled={!otpauthUrl}
          style={{ height: 36, justifyContent: 'center' }}
        >
          {pending ? 'Verifying…' : 'Verify & enable'}
        </Btn>
      </form>
    </div>
  );
}
