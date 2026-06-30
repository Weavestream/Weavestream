'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StepUpFactor } from '@weavestream/shared';
import { Btn, Dialog, Field, Input } from '../ui';
import { apiFetch } from '../../lib/api';
import { registerStepUpOpener } from '../../lib/step-up';

interface PendingPrompt {
  factor: StepUpFactor;
}

/**
 * Root-mounted step-up (re-authentication) modal.
 *
 * Registers a single opener with the step-up coordinator
 * (`lib/step-up.ts`) so `apiFetch` (reactive, on a 403) and the download
 * buttons (proactive, via `ensureStepUp`) all drive this one dialog.
 *
 * Takes only `children` — no callback props — so it stays clean under
 * the Next.js 16 RSC serializable-props rule even though it's mounted
 * from the Server Component root layout.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Resolver for the in-flight prompt. Stored in a ref (set inside the
  // opener, an event-driven context — never during render) so `settle`
  // stays a stable callback that doesn't re-bind on every keystroke.
  const resolverRef = useRef<((completed: boolean) => void) | null>(null);

  useEffect(() => {
    registerStepUpOpener(
      (factor) =>
        new Promise<boolean>((resolve) => {
          resolverRef.current = resolve;
          setCode('');
          setErr(null);
          setBusy(false);
          setPrompt({ factor });
        }),
    );
    return () => registerStepUpOpener(null);
  }, []);

  const settle = useCallback((completed: boolean) => {
    resolverRef.current?.(completed);
    resolverRef.current = null;
    setPrompt(null);
    setCode('');
    setErr(null);
    setBusy(false);
  }, []);

  const cancel = useCallback(() => settle(false), [settle]);

  const isMfa = prompt?.factor === 'mfa';
  // Trim MFA/backup codes — users paste them with stray spaces/dashes
  // (the API normalises backup codes anyway). Send password factors
  // VERBATIM: leading/trailing spaces are significant in a password, and
  // trimming here would reject one that normal login/verify accepts.
  const submitValue = isMfa ? code.trim() : code;

  const submit = useCallback(async () => {
    if (submitValue.length === 0 || busy) return;
    setBusy(true);
    setErr(null);
    const res = await apiFetch<{ ok: true }>('/auth/step-up/verify', {
      method: 'POST',
      body: JSON.stringify({ code: submitValue }),
    });
    if (!res.ok) {
      setBusy(false);
      const problem = res.problem as
        | { detail?: string; message?: string }
        | undefined;
      setErr(
        res.status === 429
          ? 'Too many attempts. Wait a moment and try again.'
          : (problem?.detail ??
              problem?.message ??
              'Verification failed. Check the code and try again.'),
      );
      return;
    }
    settle(true);
  }, [submitValue, busy, settle]);

  return (
    <>
      {children}
      {prompt && (
        <Dialog
          open
          onClose={cancel}
          title="Confirm it's you"
          width={420}
          footer={
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Btn size="sm" onClick={cancel} disabled={busy}>
                Cancel
              </Btn>
              <Btn
                size="sm"
                kind="primary"
                onClick={() => void submit()}
                disabled={busy || submitValue.length === 0}
              >
                Confirm
              </Btn>
            </div>
          }
        >
          <div
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
              {isMfa
                ? 'This action is sensitive. Enter a code from your authenticator app (or a backup code) to continue.'
                : 'This action is sensitive. Re-enter your password to continue.'}
            </p>
            <Field
              label={isMfa ? 'Authentication code' : 'Password'}
              labelVariant="plain"
            >
              <Input
                type={isMfa ? 'text' : 'password'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                autoComplete={isMfa ? 'one-time-code' : 'current-password'}
                inputMode={isMfa ? 'numeric' : undefined}
                aria-label={isMfa ? 'Authentication code' : 'Password'}
              />
            </Field>
            {err && (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
