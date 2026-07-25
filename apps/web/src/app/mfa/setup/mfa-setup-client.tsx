'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../lib/api';
import { copyToClipboard } from '../../../lib/clipboard';
import {
  BackupCodeList,
  copyBackupCodesToClipboard,
} from '../../../components/auth/backup-code-list';
import { Btn, Field, Input, useToast } from '../../../components/ui';

interface EnrollResponse {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

interface VerifyResponse {
  ok: true;
  backupCodes?: string[];
}

export default function MfaSetupClient() {
  const router = useRouter();
  const toast = useToast();
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch<EnrollResponse>('/auth/mfa/enroll', { method: 'POST' });
      if (res.ok && res.data) {
        setSecret(res.data.secret);
        setOtpauthUrl(res.data.otpauthUrl);
        setQrDataUrl(res.data.qrDataUrl);
      } else {
        setError('Could not start MFA enrollment.');
      }
    })();
  }, []);

  async function onVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await apiFetch<VerifyResponse>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    setPending(false);
    if (!res.ok) {
      setError('Invalid code. Try again.');
      return;
    }
    if (res.data?.backupCodes?.length) {
      setBackupCodes(res.data.backupCodes);
      return;
    }
    router.push('/');
  }

  // Both copy paths go through the shared clipboard helper rather than
  // `navigator.clipboard` directly: that API is undefined on a non-secure
  // origin, and this app is routinely served over plain HTTP to LAN
  // devices, where the previous code failed silently. The helper falls
  // back to `execCommand('copy')`, and returns whether the copy landed so
  // we can tell the user the truth either way.
  async function copySecret() {
    if (!secret) return;
    if (await copyToClipboard(secret)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.push('Secret copied.', 'ok');
      return;
    }
    toast.push('Clipboard unavailable — copy it manually.', 'warn');
  }

  async function onCopyBackupCodes() {
    if (!backupCodes) return;
    if (await copyBackupCodesToClipboard(backupCodes)) {
      setCopiedCodes(true);
      setTimeout(() => setCopiedCodes(false), 1500);
      toast.push('Backup codes copied.', 'ok');
      return;
    }
    toast.push('Clipboard unavailable — copy them manually.', 'warn');
  }

  const ready = Boolean(qrDataUrl && secret);

  if (backupCodes) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Save these recovery codes now. Each code works once if you lose access to
          your authenticator. They are not stored in a readable form and cannot be
          shown again — you can only replace them with a fresh set.
        </p>
        <BackupCodeList codes={backupCodes} />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I&rsquo;ve saved these codes somewhere safe.
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn type="button" kind="outline" size="md" onClick={onCopyBackupCodes}>
            {copiedCodes ? 'Copied' : 'Copy codes'}
          </Btn>
          <Btn
            type="button"
            kind="primary"
            size="md"
            disabled={!acknowledged}
            onClick={() => router.push('/')}
          >
            Continue
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 8,
        }}
      >
        {ready ? (
          <div
            style={{
              background: '#ffffff',
              padding: 12,
              borderRadius: 8,
              lineHeight: 0,
              boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrDataUrl ?? ''}
              alt="Two-factor authentication QR code"
              width={208}
              height={208}
              style={{ display: 'block', width: 208, height: 208 }}
            />
          </div>
        ) : (
          <div
            style={{
              width: 208,
              height: 208,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
              fontSize: 12,
            }}
          >
            Generating secret…
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          disabled={!ready}
          style={{
            background: 'transparent',
            border: 0,
            padding: 0,
            color: 'var(--text-2)',
            fontSize: 12,
            cursor: ready ? 'pointer' : 'default',
            textAlign: 'left',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          {showManual ? 'Hide manual setup' : "Can't scan? Enter the secret manually"}
        </button>

        {showManual && ready && (
          <div
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--line-2)',
              borderRadius: 6,
              padding: 12,
              fontSize: 11.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-2)',
              wordBreak: 'break-all',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div>
              <div
                style={{
                  color: 'var(--muted)',
                  marginBottom: 4,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                }}
              >
                Secret
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ color: 'var(--text)' }}>{secret}</span>
                <button
                  type="button"
                  onClick={copySecret}
                  style={{
                    flexShrink: 0,
                    background: 'var(--panel)',
                    border: '1px solid var(--line-2)',
                    color: 'var(--text-2)',
                    borderRadius: 4,
                    padding: '3px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div>
              <div
                style={{
                  color: 'var(--muted)',
                  marginBottom: 4,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                }}
              >
                otpauth URL
              </div>
              <div style={{ color: 'var(--text)' }}>{otpauthUrl}</div>
            </div>
          </div>
        )}
      </div>

      <form onSubmit={onVerify} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
          disabled={!ready}
          style={{ height: 36, justifyContent: 'center' }}
        >
          {pending ? 'Verifying…' : 'Verify & enable'}
        </Btn>
      </form>
    </div>
  );
}
