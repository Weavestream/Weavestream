'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { passwordSchema } from '@weavestream/shared';
import { apiFetch } from '../../../lib/api';
import { Btn, Field, Input } from '../../../components/ui';

export default function SetupForm({ token, name }: { token: string; name: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Password is too weak.');
      return;
    }
    setPending(true);
    const res = await apiFetch<{ mfaSetupRequired: boolean }>('/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
    setPending(false);
    if (!res.ok) {
      setError('Setup link is invalid or has expired.');
      return;
    }
    router.push('/mfa/setup');
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Your name">
        <Input value={name} disabled readOnly />
      </Field>
      <Field
        label="Choose a password"
        htmlFor="pw"
        help="At least 12 characters, mixing letters, numbers, and symbols."
      >
        <Input
          id="pw"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Confirm password" htmlFor="pw2" error={error ?? undefined}>
        <Input
          id="pw2"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <Btn
        type="submit"
        kind="primary"
        size="md"
        loading={pending}
        style={{ height: 36, justifyContent: 'center' }}
      >
        {pending ? 'Creating account…' : 'Continue'}
      </Btn>
    </form>
  );
}
