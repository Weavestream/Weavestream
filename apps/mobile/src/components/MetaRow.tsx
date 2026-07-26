import type { ReactNode } from 'react';

/**
 * One label/value line inside a detail screen's ShowMore metadata card.
 * Mono-uppercase label left, truncating right-aligned value; `tone`
 * flags a value that needs attention (pairs with ShowMore's collapsed
 * dot so the flagged value is never silently buried).
 */
export function MetaRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'warn';
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <span className="shrink-0 font-mono text-section uppercase tracking-[0.1em] text-muted">
        {label}
      </span>
      <span
        className={
          'min-w-0 truncate text-right text-body ' +
          (tone === 'danger'
            ? 'font-medium text-danger'
            : tone === 'warn'
              ? 'font-medium text-warn'
              : 'text-text')
        }
      >
        {value}
      </span>
    </div>
  );
}
