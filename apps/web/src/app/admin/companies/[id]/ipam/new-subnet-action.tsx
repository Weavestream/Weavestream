'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Icon } from '../../../../../components/ui';

export function NewSubnetAction() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function open() {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set('new', '1');
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <button
      type="button"
      onClick={open}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 11px',
        background: 'var(--accent-fill)',
        color: 'var(--accent-fill-ink)',
        borderRadius: 5,
        fontSize: 12.5,
        fontWeight: 600,
        letterSpacing: -0.1,
        border: 'none',
        cursor: 'pointer',
      }}
    >
      <Icon.plus size={13} />
      New subnet
    </button>
  );
}
