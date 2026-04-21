import type { ReactNode } from 'react';

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--muted)',
        border: '1px solid var(--line-2)',
        borderRadius: 3,
        padding: '1px 4px',
        background: 'var(--panel-2)',
        lineHeight: 1.2,
      }}
    >
      {children}
    </kbd>
  );
}
