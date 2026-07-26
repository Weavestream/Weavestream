'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { copyToClipboard, copyWithPromise } from '@weavestream/shared/browser';
import { Btn, Icon, useToast } from '../ui';

const AUTO_HIDE_MS = 30_000;

export interface PasswordInlineActionsProps {
  companyId: string;
  passwordId: string;
  requiresReason?: boolean;
  /** Include the "reveal" button alongside "copy". */
  showReveal?: boolean;
  /** Render a "copy TOTP" button (requires `hasTotp`). */
  showTotpCopy?: boolean;
  /** Whether this password has a TOTP configured. */
  hasTotp?: boolean;
  /** Render a "copy username" button (requires `username`). */
  showUsernameCopy?: boolean;
  /** Username plaintext to copy without hitting the server. */
  username?: string | null;
  /** Render a "copy URL" button (requires `url`). */
  showLinkCopy?: boolean;
  /** URL plaintext to copy without hitting the server. */
  url?: string | null;
  /** Changing this clears any cached plaintext (e.g. after restore). */
  resetKey?: string | number;
}

/**
 * Compact reveal / copy button pair for embedding in table rows,
 * sidebar panels, or anywhere the full `PasswordRevealField` would be
 * too tall.
 *
 * - Copy button always fetches fresh plaintext via `POST /reveal`,
 *   copies it to the clipboard, then throws the plaintext away. The
 *   user never sees it in that path — saves one click compared to the
 *   classic "reveal → select → copy" dance.
 * - Reveal button toggles an inline pill that shows plaintext for 30s
 *   and auto-hides. Handy when you want to type the password manually
 *   or show someone over your shoulder.
 */
export function PasswordInlineActions({
  companyId,
  passwordId,
  requiresReason,
  showReveal = true,
  showTotpCopy = false,
  hasTotp = false,
  showUsernameCopy = false,
  username,
  showLinkCopy = false,
  url,
  resetKey,
}: PasswordInlineActionsProps) {
  const toast = useToast();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<'reveal' | 'copy' | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [reason, setReason] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, setTick] = useState(0);

  const hide = useCallback(() => {
    setPlaintext(null);
    setRevealedAt(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    timerRef.current = null;
    tickRef.current = null;
  }, []);

  useEffect(() => () => hide(), [hide]);
  useEffect(() => {
    hide();
  }, [resetKey, hide]);

  async function fetchPlaintext(withReason?: string): Promise<string | null> {
    setBusy(true);
    const body: Record<string, unknown> = {};
    if (withReason) body.reason = withReason;
    const res = await apiFetch<{ password: string }>(
      `/companies/${companyId}/passwords/${passwordId}/reveal`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as
        | { error?: string; message?: string }
        | undefined;
      if (problem?.error === 'ReasonRequired') {
        setPromptOpen(true);
        return null;
      }
      toast.push(problem?.message ?? 'Failed to reveal password', 'danger');
      return null;
    }
    return res.data.password;
  }

  async function doReveal(withReason?: string) {
    if (plaintext) {
      hide();
      return;
    }
    if (requiresReason && !withReason) {
      setPending('reveal');
      setPromptOpen(true);
      return;
    }
    const pw = await fetchPlaintext(withReason);
    if (!pw) return;
    setPlaintext(pw);
    setRevealedAt(Date.now());
    timerRef.current = setTimeout(hide, AUTO_HIDE_MS);
    tickRef.current = setInterval(() => setTick((t) => t + 1), 500);
  }

  function doCopy(withReason?: string) {
    if (plaintext) {
      // Already resolved; a synchronous writeText suffices.
      void copyToClipboard(plaintext).then((ok) =>
        toast.push(ok ? 'Password copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger'),
      );
      return;
    }
    if (requiresReason && !withReason) {
      setPending('copy');
      setPromptOpen(true);
      return;
    }
    // Call SYNCHRONOUSLY in the click handler so `clipboard.write`
    // holds the user-gesture token while we go fetch the plaintext.
    setBusy(true);
    let needsReason = false;
    void copyWithPromise(async () => {
      const body: Record<string, unknown> = {};
      if (withReason) body.reason = withReason;
      const res = await apiFetch<{ password: string }>(
        `/companies/${companyId}/passwords/${passwordId}/reveal`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (!res.ok || !res.data) {
        const problem = res.problem as
          | { error?: string; message?: string }
          | undefined;
        if (problem?.error === 'ReasonRequired') needsReason = true;
        throw new Error(problem?.message ?? 'Failed to reveal password');
      }
      return res.data.password;
    }).then((ok) => {
      setBusy(false);
      if (needsReason) {
        setPending('copy');
        setPromptOpen(true);
        return;
      }
      toast.push(ok ? 'Password copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
    });
  }

  function doCopyTotp() {
    setBusy(true);
    void copyWithPromise(async () => {
      const res = await apiFetch<{ code: string }>(
        `/companies/${companyId}/passwords/${passwordId}/totp`,
        { method: 'POST' },
      );
      if (!res.ok || !res.data) {
        throw new Error(
          (res.problem as { message?: string } | undefined)?.message ??
            'Failed to generate code',
        );
      }
      return res.data.code;
    }).then((ok) => {
      setBusy(false);
      toast.push(ok ? 'One-time code copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
    });
  }

  async function doCopyUsername() {
    if (!username) return;
    const ok = await copyToClipboard(username);
    toast.push(ok ? 'Username copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  async function doCopyUrl() {
    if (!url) return;
    const ok = await copyToClipboard(url);
    toast.push(ok ? 'URL copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  const remainingS =
    plaintext && revealedAt
      ? Math.ceil(
          Math.max(0, AUTO_HIDE_MS - (Date.now() - revealedAt)) / 1000,
        )
      : 0;

  if (promptOpen) {
    return (
      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          minWidth: 0,
        }}
      >
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason…"
          style={{
            flex: 1,
            minWidth: 80,
            padding: '4px 6px',
            border: '1px solid var(--line)',
            borderRadius: 5,
            fontSize: 12,
            background: 'var(--panel)',
            color: 'var(--text)',
          }}
        />
        <Btn
          size="sm"
          kind="primary"
          disabled={!reason.trim() || busy}
          onClick={() => {
            const r = reason.trim();
            setReason('');
            setPromptOpen(false);
            if (pending === 'reveal') void doReveal(r);
            if (pending === 'copy') doCopy(r);
            setPending(null);
          }}
        >
          OK
        </Btn>
        <Btn
          size="sm"
          onClick={() => {
            setPromptOpen(false);
            setReason('');
            setPending(null);
          }}
        >
          <Icon.x size={12} />
        </Btn>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        flexWrap: 'nowrap',
      }}
    >
      {showLinkCopy && (
        <Btn
          size="sm"
          disabled={busy || !url}
          onClick={() => void doCopyUrl()}
          title={url ? 'Copy URL' : 'No URL'}
          iconOnly
        >
          <Icon.link size={12} />
        </Btn>
      )}
      {showUsernameCopy && (
        <Btn
          size="sm"
          disabled={busy || !username}
          onClick={() => void doCopyUsername()}
          title={username ? 'Copy username' : 'No username'}
          iconOnly
        >
          <Icon.person size={12} />
        </Btn>
      )}
      {showReveal && (
        <Btn
          size="sm"
          disabled={busy}
          onClick={() => void doReveal()}
          title={plaintext ? 'Hide' : 'Reveal'}
          iconOnly
        >
          {plaintext ? <Icon.eyeOff size={12} /> : <Icon.eye size={12} />}
        </Btn>
      )}
      <Btn
        size="sm"
        disabled={busy}
        onClick={() => doCopy()}
        title="Copy password"
        iconOnly
      >
        <Icon.copy size={12} />
      </Btn>
      {showTotpCopy && hasTotp && (
        <Btn
          size="sm"
          disabled={busy}
          onClick={() => doCopyTotp()}
          title="Copy one-time code"
          iconOnly
        >
          <Icon.shield size={12} />
        </Btn>
      )}
      {plaintext && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            borderRadius: 4,
            background: 'var(--warn-soft)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text)',
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
          title={`Auto-hides in ${remainingS}s`}
        >
          {plaintext}
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>
            {remainingS}s
          </span>
        </span>
      )}
    </div>
  );
}
