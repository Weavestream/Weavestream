'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { copyToClipboard, copyWithPromise } from '../../lib/clipboard';
import { Btn, Icon, useToast } from '../ui';

const AUTO_HIDE_MS = 30_000;
const MASK = '••••••••••••';

export interface PasswordRevealFieldProps {
  companyId: string;
  passwordId: string;
  /**
   * True when the record was created with `require_reason_to_view`.
   * We prompt inline rather than through a separate dialog so the
   * reveal flow stays one click away for power users.
   */
  requiresReason?: boolean;
  /**
   * Compact layout for sidebar/panel embeds — drops the label, shrinks
   * the font, and makes the row single-line with horizontal scrolling
   * instead of wrapping so narrow asides don't grow vertically.
   */
  compact?: boolean;
  /**
   * Changing this resets any cached plaintext. Wire it to the
   * `updatedAt`/`version` of the record so restoring from history
   * forces a fresh reveal and the user doesn't keep seeing the old
   * value.
   */
  resetKey?: string | number;
}

/**
 * Canonical password reveal widget.
 *
 * Defaults to the masked state. On click we POST `/reveal`, show the
 * plaintext, start a 30s auto-hide countdown, and make the value
 * unselectable + click-to-copy. After the countdown expires — or the
 * component unmounts — the plaintext is cleared from React state.
 *
 * This is the ONLY place in the UI that handles plaintext passwords.
 * Copy uses `navigator.clipboard.writeText`, which doesn't require
 * pasting to actually land the string in the OS clipboard, so the
 * user can copy and close immediately.
 */
export function PasswordRevealField(props: PasswordRevealFieldProps) {
  const { companyId, passwordId, requiresReason, compact, resetKey } = props;
  const toast = useToast();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [promptingReason, setPromptingReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState<'reveal' | 'copy'>('reveal');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [_tick, setTick] = useState(0);

  const hide = useCallback(() => {
    setPlaintext(null);
    setRevealedAt(null);
    setReason('');
    setPromptingReason(false);
    setCopied(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => hide, [hide]);

  // When `resetKey` changes (typically after a version restore) we
  // drop any cached plaintext so the next reveal always fetches fresh
  // data from the server. Without this the user would keep seeing the
  // pre-restore password until they manually hide.
  useEffect(() => {
    hide();
  }, [resetKey, hide]);

  const doReveal = useCallback(
    async (withReason: string | undefined) => {
      setBusy(true);
      setErr(null);
      const body: Record<string, unknown> = {};
      if (withReason) body.reason = withReason;
      const res = await apiFetch<{ password: string }>(
        `/companies/${companyId}/passwords/${passwordId}/reveal`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      setBusy(false);
      if (!res.ok || !res.data) {
        const problem = res.problem as { error?: string; message?: string } | undefined;
        if (problem?.error === 'ReasonRequired') {
          setPromptingReason(true);
          return;
        }
        setErr(problem?.message ?? 'Failed to reveal password');
        return;
      }
      setPlaintext(res.data.password);
      setRevealedAt(Date.now());
      setPromptingReason(false);
      timerRef.current = setTimeout(hide, AUTO_HIDE_MS);
      tickRef.current = setInterval(() => setTick((t) => t + 1), 500);
    },
    [companyId, passwordId, hide],
  );

  async function handleReveal() {
    if (plaintext) {
      hide();
      return;
    }
    if (requiresReason) {
      setPendingAction('reveal');
      setPromptingReason(true);
      return;
    }
    await doReveal(undefined);
  }

  /**
   * Called from the reason prompt's "Reveal" button. Depending on
   * which action the user initiated (reveal vs copy), we either show
   * the plaintext or go straight to the clipboard without displaying.
   */
  async function submitReasonPrompt() {
    const r = reason.trim() || undefined;
    if (pendingAction === 'copy') {
      setBusy(true);
      const ok = await copyWithPromise(async () => {
        const body: Record<string, unknown> = {};
        if (r) body.reason = r;
        const res = await apiFetch<{ password: string }>(
          `/companies/${companyId}/passwords/${passwordId}/reveal`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (!res.ok || !res.data) {
          throw new Error(
            (res.problem as { message?: string } | undefined)?.message ??
              'Failed to reveal password',
          );
        }
        return res.data.password;
      });
      setBusy(false);
      setPromptingReason(false);
      setReason('');
      toast.push(ok ? 'Password copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
      return;
    }
    await doReveal(r);
  }

  /**
   * Copy fetches plaintext if not already revealed, writes it to the
   * clipboard, and (when the user hadn't clicked "reveal") throws it
   * away again. That saves a click: the common flow is "copy password
   * to paste elsewhere", not "eyeball this string".
   */
  async function handleCopy() {
    if (plaintext) {
      const ok = await copyToClipboard(plaintext);
      if (ok) {
        toast.push('Password copied', 'ok');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } else {
        toast.push('Clipboard unavailable', 'danger');
      }
      return;
    }
    // Reuse the same reason-prompt machinery as `handleReveal`.
    if (requiresReason) {
      setPendingAction('copy');
      setPromptingReason(true);
      return;
    }
    // `copyWithPromise` is called SYNCHRONOUSLY inside the click
    // handler so the browser ties `clipboard.write` to this gesture.
    // The decrypted password is fetched inside the ClipboardItem
    // promise — by the time it resolves, Safari/Chromium have already
    // reserved the clipboard slot.
    setBusy(true);
    let reasonMessage: string | null = null;
    const ok = await copyWithPromise(async () => {
      const res = await apiFetch<{ password: string }>(
        `/companies/${companyId}/passwords/${passwordId}/reveal`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (!res.ok || !res.data) {
        const problem = res.problem as
          | { error?: string; message?: string }
          | undefined;
        if (problem?.error === 'ReasonRequired') {
          reasonMessage = 'ReasonRequired';
        }
        throw new Error(problem?.message ?? 'Failed to reveal password');
      }
      return res.data.password;
    });
    setBusy(false);
    if (reasonMessage === 'ReasonRequired') {
      setPendingAction('copy');
      setPromptingReason(true);
      return;
    }
    if (ok) {
      toast.push('Password copied', 'ok');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.push('Clipboard unavailable', 'danger');
    }
  }

  const remainingMs =
    plaintext && revealedAt ? Math.max(0, AUTO_HIDE_MS - (Date.now() - revealedAt)) : 0;
  const remainingS = Math.ceil(remainingMs / 1000);

  if (promptingReason) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>
          Please provide a reason for revealing this credential.
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer ticket #1234"
            style={{
              flex: 1,
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 13,
              background: 'var(--elev)',
              color: 'var(--fg)',
            }}
          />
          <Btn
            kind="primary"
            size="sm"
            onClick={() => void submitReasonPrompt()}
            disabled={busy || reason.trim().length < 1}
          >
            {pendingAction === 'copy' ? 'Copy' : 'Reveal'}
          </Btn>
          <Btn size="sm" onClick={() => setPromptingReason(false)}>
            Cancel
          </Btn>
        </div>
        {err && (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily:
            'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
          fontSize: compact ? 12 : 14,
        }}
      >
        <span
          style={{
            flex: 1,
            padding: compact ? '4px 8px' : '8px 10px',
            border: '1px solid var(--line)',
            borderRadius: 6,
            background: plaintext ? 'var(--warn-soft)' : 'var(--elev)',
            userSelect: plaintext ? 'none' : 'auto',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
            color: 'var(--fg)',
          }}
        >
          {plaintext ?? MASK}
        </span>
        <Btn
          size="sm"
          kind={plaintext ? 'ghost' : 'primary'}
          onClick={() => void handleReveal()}
          disabled={busy}
          title={plaintext ? 'Hide' : 'Reveal'}
        >
          {plaintext ? <Icon.eyeOff size={14} /> : <Icon.eye size={14} />}
        </Btn>
        <Btn
          size="sm"
          onClick={() => void handleCopy()}
          disabled={busy}
          title="Copy password"
        >
          {copied ? <Icon.check size={14} /> : <Icon.copy size={14} />}
          {copied ? ' copied' : ''}
        </Btn>
      </div>
      {plaintext && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted, #6b7280)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon.clock size={11} />
            Auto-hides in {remainingS}s
          </span>
          <button
            type="button"
            onClick={hide}
            style={{
              background: 'transparent',
              border: 0,
              padding: 0,
              color: 'var(--muted)',
              fontSize: 11,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Hide now
          </button>
        </div>
      )}
      {err && !promptingReason && (
        <div style={{ fontSize: 12, color: 'var(--danger, #dc2626)' }}>{err}</div>
      )}
    </div>
  );
}
