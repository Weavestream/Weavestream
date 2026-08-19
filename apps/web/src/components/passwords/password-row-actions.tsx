'use client';

import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { copyToClipboard, copyWithPromise } from '@weavestream/shared/browser';
import { Btn, Icon, useToast } from '../ui';

export interface PasswordRowActionsProps {
  companyId: string;
  passwordId: string;
  username: string | null;
  url: string | null;
  requiresReason?: boolean;
  /**
   * Opt-in table treatment: the icons rest at `--faint` and lift as the
   * pointer enters the row, so three glyphs per row stop competing with
   * the data they sit beside.
   *
   * Off everywhere by default. The detail sidebar has no row to hover,
   * so it must keep the strength it has today — which is exactly why
   * this is a prop rather than a change to how the component paints.
   */
  recessive?: boolean;
}

/**
 * Plain icon-only copy buttons for the passwords table row:
 * link (copy URL), user (copy username), password (copy password).
 *
 * Styling deliberately matches the sidebar `PasswordInlineActions` —
 * no tints, no borders — so the same three actions read identically
 * in both surfaces. The OTP column already renders its own copy-TOTP
 * button, so we intentionally skip it here to avoid duplicating the
 * same action in two adjacent cells.
 *
 * - Username and URL copies run synchronously against
 *   `copyToClipboard` — both values already live on the summary row,
 *   no network call needed.
 * - Password copy calls `POST /reveal`, writes plaintext to the
 *   clipboard via `copyWithPromise`, and discards it. Using
 *   `copyWithPromise` keeps the clipboard write tied to the click's
 *   user-gesture token so Safari/Chromium don't reject it after the
 *   awaited fetch. Honours `requireReasonToView` by opening an inline
 *   reason prompt.
 */
export function PasswordRowActions({
  companyId,
  passwordId,
  username,
  url,
  requiresReason,
  recessive,
}: PasswordRowActionsProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [reason, setReason] = useState('');

  async function copyUsername() {
    if (!username) return;
    const ok = await copyToClipboard(username);
    toast.push(ok ? 'Username copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  async function copyUrl() {
    if (!url) return;
    const ok = await copyToClipboard(url);
    toast.push(ok ? 'URL copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  function copyPassword(withReason?: string) {
    // MUST stay synchronous up to the `copyWithPromise` call: the
    // browser binds the clipboard write to *this* click's gesture
    // token, and any `await` before that strips the token away, which
    // is exactly what produced the earlier "Clipboard unavailable"
    // errors. Side-effects happen in the `.then` callback instead.
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
        setPromptOpen(true);
        return;
      }
      toast.push(ok ? 'Password copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
    });
  }

  function handleCopyPassword() {
    if (requiresReason) {
      setPromptOpen(true);
      return;
    }
    copyPassword(undefined);
  }

  if (promptOpen) {
    return (
      <div
        style={{
          display: 'inline-flex',
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
            minWidth: 0,
            width: 140,
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
            copyPassword(r);
          }}
        >
          OK
        </Btn>
        <Btn
          size="sm"
          onClick={() => {
            setPromptOpen(false);
            setReason('');
          }}
          iconOnly
        >
          <Icon.x size={12} />
        </Btn>
      </div>
    );
  }

  // `Btn` writes `color` into the inline style, which no stylesheet rule
  // can outrank without `!important`. So the buttons resolve their ink
  // from a custom property instead and `.pw-row-actions` in globals.css
  // moves that property per state — the one hook a parent row's `:hover`
  // can actually reach.
  const ink = recessive
    ? { color: 'var(--pw-action-ink, var(--text-2))' }
    : undefined;

  return (
    <div
      className={recessive ? 'pw-row-actions' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flexWrap: 'nowrap',
      }}
    >
      <Btn
        size="sm"
        disabled={busy || !url}
        onClick={() => void copyUrl()}
        title={url ? 'Copy URL' : 'No URL'}
        style={ink}
        iconOnly
      >
        <Icon.link size={12} />
      </Btn>
      <Btn
        size="sm"
        disabled={busy || !username}
        onClick={() => void copyUsername()}
        title={username ? 'Copy username' : 'No username'}
        style={ink}
        iconOnly
      >
        <Icon.person size={12} />
      </Btn>
      <Btn
        size="sm"
        disabled={busy}
        onClick={handleCopyPassword}
        title="Copy password"
        style={ink}
        iconOnly
      >
        <Icon.copy size={12} />
      </Btn>
    </div>
  );
}
