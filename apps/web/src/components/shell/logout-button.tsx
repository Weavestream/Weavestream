'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../lib/api';
import { Icon } from '../ui';

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await apiFetch('/auth/logout', { method: 'POST' });
        router.push('/login');
        router.refresh();
      }}
      title="Sign out"
      style={{
        width: 22,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dim)',
      }}
    >
      <Icon.logout size={14} />
    </button>
  );
}
