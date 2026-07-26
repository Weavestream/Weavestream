import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * The T2 disclosure, rebuilt for mobile with the two rules the desktop
 * original (`apps/web/src/components/ui/show-more.tsx`) was built to
 * enforce — the component is not imported across the app boundary, the
 * doctrine is:
 *
 *  1. Primary content — credentials, linked items — NEVER goes inside
 *     a disclosure. Callers put system metadata here, nothing a
 *     technician came for.
 *  2. The collapsed label carries an attention dot when something
 *     hidden needs review, so collapsing can never silently bury an
 *     expiring credential. The dot renders only while collapsed — once
 *     open, the content itself is the signal.
 */
export function ShowMore({
  label = 'Show more',
  lessLabel = 'Show less',
  dot = null,
  children,
}: {
  label?: string;
  lessLabel?: string;
  dot?: 'danger' | 'warn' | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          'flex h-tap items-center gap-1.5 self-start rounded-btn px-1 ' +
          'font-mono text-meta text-muted active:bg-panel-2'
        }
      >
        {open ? lessLabel : label}
        {!open && dot && (
          <>
            <span
              aria-hidden
              className={
                'h-2 w-2 rounded-full ' +
                (dot === 'danger' ? 'bg-danger' : 'bg-warn')
              }
            />
            <span className="sr-only">— something here needs review</span>
          </>
        )}
        <Icon
          name="expand_more"
          size={20}
          className={'transition-transform' + (open ? ' rotate-180' : '')}
        />
      </button>
      {open && children}
    </div>
  );
}
