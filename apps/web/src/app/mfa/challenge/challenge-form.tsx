'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../lib/api';
import { Btn, Field, Input } from '../../../components/ui';

export default function MfaChallengeForm() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await apiFetch('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    setPending(false);
    if (!res.ok) {
      setError('Invalid code.');
      return;
    }
    router.push('/');
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
        style={{ height: 36, justifyContent: 'center' }}
      >
        {pending ? 'Verifying…' : 'Verify'}
      </Btn>
    </form>
  );
}
