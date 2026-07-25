'use client';

import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import {
  BackupCodeList,
  copyBackupCodesToClipboard,
} from '../../components/auth/backup-code-list';
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
      // This route is step-up gated, and a dismissed challenge comes back
      // as the original 403. That is the user declining, not a failure —
      // stay silent, matching `downloadWithStepUp`. Every other outcome
      // (including a step-up 403 with no modal available, or a retry that
      // stayed blocked) is real and must be reported.
      if (res.stepUpCancelled) return;
      toast.push('Could not regenerate backup codes.', 'danger');
      return;
    }
    setCodes(res.data.backupCodes);
  }

  async function copyCodes() {
    if (!codes) return;
    if (await copyBackupCodesToClipboard(codes)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.push('Backup codes copied.', 'ok');
      return;
    }
    toast.push('Clipboard unavailable — copy them manually.', 'warn');
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
            authenticator code. Your previous codes no longer work.
          </p>
          {codes && <BackupCodeList codes={codes} />}
        </div>
      </Dialog>
    </>
  );
}
