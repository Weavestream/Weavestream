'use client';

import { useState } from 'react';
import { passwordSchema } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { Btn, Field, Input, useToast } from '../../components/ui';

export function PasswordForm() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('New password and confirmation do not match.');
      return;
    }
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Password is too weak.');
      return;
    }
    setPending(true);
    const res = await apiFetch('/me/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    setPending(false);
    if (!res.ok) {
      const p = res.problem as { detail?: string } | undefined;
      setError(p?.detail ?? 'Password change failed.');
      return;
    }
    toast.push('Password updated. Other sessions signed out.', 'ok');
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 14,
      }}
    >
      <Field label="Current password" htmlFor="curr">
        <Input
          id="curr"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </Field>
      <Field label="New password" htmlFor="next">
        <Input
          id="next"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </Field>
      <Field label="Confirm new password" htmlFor="conf" error={error ?? undefined}>
        <Input
          id="conf"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </Field>
      <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
        <Btn type="submit" kind="primary" loading={pending}>
          Change password
        </Btn>
      </div>
    </form>
  );
}
