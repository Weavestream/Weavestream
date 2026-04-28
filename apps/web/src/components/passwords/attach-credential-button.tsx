'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import type { PasswordFolderRow } from '../../lib/server-api';
import { Btn, Icon } from '../ui';
import { CreatePasswordDialog } from './create-password-dialog';

/**
 * Inline "attach credential" link for the asset CredentialsPanel.
 *
 * Opens the shared `CreatePasswordDialog` directly on the asset page
 * instead of navigating to the vault browser — the user stays where
 * they were, and a `router.refresh()` pulls the new row into the
 * panel once the server write completes.
 */
export function AttachCredentialButton({
  companyId,
  assetId,
  folders,
  generatorDefaults,
  label,
  variant = 'text',
}: {
  companyId: string;
  assetId: string;
  folders: PasswordFolderRow[];
  generatorDefaults: PasswordGeneratorDefaults;
  label: string;
  variant?: 'text' | 'button';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  return (
    <>
      {variant === 'button' ? (
        <Btn
          kind="ghost"
          size="sm"
          icon={Icon.plus}
          onClick={() => setOpen(true)}
          aria-label={label}
        >
          {label}
        </Btn>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            background: 'transparent',
            border: 0,
            padding: 0,
            fontSize: 12,
            color: 'var(--accent)',
            cursor: 'pointer',
            textDecoration: 'none',
          }}
        >
          {label}
        </button>
      )}
      {open && (
        <CreatePasswordDialog
          companyId={companyId}
          folders={folders}
          assetId={assetId}
          generatorDefaults={generatorDefaults}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            startTransition(() => router.refresh());
          }}
          title="Attach credential"
        />
      )}
    </>
  );
}
