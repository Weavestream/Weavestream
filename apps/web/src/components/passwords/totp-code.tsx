'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { copyToClipboard } from '@weavestream/shared/browser';
import { Btn, Icon } from '../ui';

export interface TotpCodeProps {
  companyId: string;
  passwordId: string;
  period?: number;
  digits?: number;
  /** Compact inline layout for tables (no ring, tight padding). */
  compact?: boolean;
  /** Changing this forces a fresh code fetch (e.g. after restore). */
  resetKey?: string | number;
}

/**
 * Live 6-digit TOTP code with a refreshing countdown.
 *
 * The shared secret never leaves the API — this component asks the
 * server for a code (`POST /passwords/:id/totp`), shows it, and waits
 * for the server-reported `validUntil` to pass before requesting the
 * next one. That keeps the browser's wall-clock from drifting from
 * the server's TOTP clock and makes algorithm/digits/period changes a
 * pure server-side concern.
 */
export function TotpCode({
  companyId,
  passwordId,
  compact,
  resetKey,
}: TotpCodeProps) {
  const [code, setCode] = useState<string | null>(null);
  const [validUntil, setValidUntil] = useState<number | null>(null);
  const [period, setPeriod] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tick, setTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCode = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const res = await apiFetch<{
      code: string;
      period: number;
      validUntil: string;
    }>(`/companies/${companyId}/passwords/${passwordId}/totp`, {
      method: 'POST',
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      setErr(
        (res.problem as { message?: string } | undefined)?.message ??
          'Failed to generate TOTP',
      );
      return;
    }
    setCode(res.data.code);
    setPeriod(res.data.period);
    const vu = Date.parse(res.data.validUntil);
    setValidUntil(vu);
    if (timerRef.current) clearTimeout(timerRef.current);
    const delta = Math.max(500, vu - Date.now() + 200);
    timerRef.current = setTimeout(() => void fetchCode(), delta);
  }, [companyId, passwordId]);

  useEffect(() => {
    // Clear any prior code when resetKey changes (e.g. version restore)
    // so we always display the freshly-derived value.
    setCode(null);
    setValidUntil(null);
    void fetchCode();
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => {
      clearInterval(id);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // `fetchCode` is stable (memoised on ids).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, passwordId, resetKey]);

  // Tick keeps the countdown ring repainting every 500ms. We read it
  // so the linter doesn't flag the useState as unused; React already
  // sees the dependency via the `setTick` call above.
  void tick;

  const remainingMs =
    validUntil !== null ? Math.max(0, validUntil - Date.now()) : 0;
  const progress = period > 0 ? 1 - remainingMs / (period * 1000) : 1;
  const remainingS = Math.ceil(remainingMs / 1000);

  async function handleCopy() {
    if (!code) return;
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setErr('clipboard-blocked');
    }
  }

  if (compact) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
        }}
      >
        <code
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            letterSpacing: 1.5,
            color: 'var(--text)',
            padding: '2px 6px',
            borderRadius: 4,
            background: 'var(--panel-2)',
            minWidth: 64,
            textAlign: 'center',
          }}
        >
          {code ? formatCode(code) : '— — —'}
        </code>
        <span
          style={{
            fontSize: 10,
            color: 'var(--muted)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {remainingS}s
        </span>
        <Btn
          size="sm"
          onClick={() => void handleCopy()}
          disabled={!code || busy}
          title="Copy TOTP"
          iconOnly
        >
          {copied ? <Icon.check size={12} /> : <Icon.copy size={12} />}
        </Btn>
        {err && <span style={{ fontSize: 10, color: 'var(--danger)' }}>{err}</span>}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: 10,
        border: '1px solid var(--line-2)',
        borderRadius: 8,
        // `--elev` rather than `--panel-2`: this card sits one grid row
        // below the `PasswordRevealField` value box inside the same
        // `Panel`, filling the same role, and that box is `--elev`.
        // `--panel-2` reads as a heavier, different element in light
        // theme, where the reveal field is flush white.
        background: 'var(--elev)',
      }}
    >
      <div
        aria-hidden
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          // `--line-3` rather than the card's `--line-2`: the unfilled
          // arc is a 4px track carrying the countdown, not a hairline, so
          // it needs the strongest line token to read against the ring's
          // inner fill.
          background: `conic-gradient(var(--accent, #2563eb) ${progress * 360}deg, var(--line-3) 0deg)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            // Matches the card fill so the ring reads as a donut cut out
            // of the card rather than a disc floating on it.
            background: 'var(--elev)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          {remainingS}
        </div>
      </div>
      <div
        style={{
          fontFamily:
            'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
          fontSize: 22,
          letterSpacing: 4,
          color: 'var(--text)',
          flex: 1,
        }}
      >
        {code ? formatCode(code) : '— — — — — —'}
      </div>
      <Btn
        size="sm"
        onClick={() => void handleCopy()}
        disabled={!code || busy}
        title="Copy"
      >
        <Icon.copy size={14} />
        {copied ? ' copied' : ''}
      </Btn>
      {err && (
        <div style={{ fontSize: 11, color: 'var(--danger)' }}>{err}</div>
      )}
    </div>
  );
}

function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}
