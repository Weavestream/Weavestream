'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isCurrentPasswordInvalidProblem, passwordSchema } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { Btn, Field, Input, useToast } from '../../components/ui';

export function PasswordForm() {
  const toast = useToast();
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  /**
   * Kept apart from `error` because it belongs to a different control. The
   * generic `error` renders under the confirmation field, which is right for
   * a mismatch or a weak-password message but actively misleading for "your
   * current password is wrong" — the user would go and retype the field that
   * was fine. The problem code identifies the field precisely, so the
   * message goes on it.
   */
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCurrentError(null);
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
      // This route 401s for two unrelated reasons and `apiFetch` has no 401
      // handling of its own, so the branch belongs here. A 401 CARRYING the
      // code means the current-password field was wrong — stay on the form
      // and mark THAT field. A 401 WITHOUT it means the session is gone
      // (`AuthGuard` throws a bare one after `silentRefresh` already
      // failed), and rendering "Unauthorized" in the form would leave the
      // user retyping a correct password against a dead cookie. `refresh()`
      // matters as much as `push()`: without it the cached `/me` RSC payload
      // can re-render behind the navigation. Same pattern as
      // `shell/logout-button.tsx`.
      const p = res.problem as { detail?: string } | undefined;
      if (res.status === 401) {
        if (isCurrentPasswordInvalidProblem(res.problem)) {
          setCurrentError(p?.detail ?? 'Current password is incorrect.');
          return;
        }
        router.push('/login');
        router.refresh();
        return;
      }
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
      <Field label="Current password" htmlFor="curr" error={currentError ?? undefined}>
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
