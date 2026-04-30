'use client';

import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { Btn, Dialog, Icon, useToast } from '../../components/ui';

type RegenerateResponse = { backupCodes: string[] };

export function MfaBackupCodes({ enabled }: { enabled: boolean }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  if (!enabled) return null;

  async function regenerate() {
    setPending(true);
    const res = await apiFetch<RegenerateResponse>('/me/mfa/backup-codes/regenerate', {
      method: 'POST',
    });
    setPending(false);
    if (!res.ok || !res.data) {
      toast.push('Could not regenerate backup codes.', 'danger');
      return;
    }
    setCodes(res.data.backupCodes);
  }

  async function copyCodes() {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // noop — user can still read the codes
    }
  }

  return (
    <>
      <Btn kind="outline" size="md" icon={Icon.key} onClick={regenerate} loading={pending}>
        Regenerate codes
      </Btn>

      <Dialog
        open={codes !== null}
        onClose={() => setCodes(null)}
        title="Save backup codes"
        width={480}
        footer={
          <>
            <Btn kind="outline" onClick={copyCodes}>
              {copied ? 'Copied' : 'Copy codes'}
            </Btn>
            <Btn kind="primary" onClick={() => setCodes(null)}>
              Done
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
            Store these somewhere safe. Each code can be used once instead of your
            authenticator code.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 8,
              padding: 12,
              background: 'var(--panel-2)',
              border: '1px solid var(--line-2)',
              borderRadius: 8,
            }}
          >
            {codes?.map((code) => (
              <code
                key={code}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text)',
                }}
              >
                {code}
              </code>
            ))}
          </div>
        </div>
      </Dialog>
    </>
  );
}
