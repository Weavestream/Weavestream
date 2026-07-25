'use client';

import { Tag } from '../ui';
import { copyToClipboard } from '../../lib/clipboard';

/**
 * The one-time recovery-code block, shared by first-time MFA enrollment
 * (`app/mfa/setup/mfa-setup-client.tsx`) and self-service regeneration
 * (`app/me/mfa-backup-codes.tsx`).
 *
 * Both surfaces render the same grid, and both hand the user a value the
 * server cannot reproduce — `UserMfaBackupCode` stores Argon2 hashes, so
 * once this component unmounts the plaintext is gone for good. The warn
 * tag is the house treatment for that (see the invite-link blocks in
 * `admin/(global)/users/[id]/user-actions.tsx` and `create-user-button.tsx`).
 *
 * The Copy button deliberately lives with the caller, not here: enrollment
 * places it in an inline row, `/me` places it in a `Dialog` footer. Callers
 * share the clipboard behaviour via `copyBackupCodesToClipboard` below.
 */
export function BackupCodeList({ codes }: { codes: string[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        {codes.map((code) => (
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
      <Tag tone="warn">Shown once — copy them now.</Tag>
    </div>
  );
}

/**
 * Copy a set of backup codes, one per line.
 *
 * Goes through the shared `copyToClipboard` rather than
 * `navigator.clipboard.writeText` directly: that API is undefined on a
 * non-secure origin, and Weavestream is routinely served over plain HTTP
 * to LAN devices. `copyToClipboard` falls back to `execCommand('copy')`,
 * which has no secure-context requirement.
 *
 * Returns whether the copy landed so the caller can toast honestly
 * instead of silently doing nothing.
 */
export async function copyBackupCodesToClipboard(
  codes: string[],
): Promise<boolean> {
  return copyToClipboard(codes.join('\n'));
}
