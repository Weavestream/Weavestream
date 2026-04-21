'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../lib/api';
import { Btn, Field, Input } from '../../components/ui';

interface LoginResponse {
  mfaSetupRequired: boolean;
  mfaChallengeRequired: boolean;
  user: { id: string; email: string };
}

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
    if (res.data.mfaSetupRequired) router.push('/mfa/setup');
    else if (res.data.mfaChallengeRequired) router.push('/mfa/challenge');
    else router.push('/');
  }

  return (
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
  );
}
