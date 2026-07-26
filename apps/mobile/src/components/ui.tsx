import type { ReactNode } from 'react';

/**
 * Minimal primitives for the Phase 0 auth screens.
 *
 * Deliberately not a component library — Phase 1 builds the real set
 * against the design handoff. These exist so the auth screens are
 * usable and honour the two non-negotiables (44pt targets, 16px input
 * font so iOS doesn't zoom the viewport) without pre-empting that work.
 *
 * Nothing here may be imported from `apps/web` — mobile's radii are
 * 9–30px against desktop's 3–8px, and its icons are drawn for a 25px
 * tab bar (CLAUDE.md).
 */

export function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pt-safe-t pb-safe-b">
      {children}
    </main>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <h1 className="pt-8 pb-1 text-screen-title font-semibold text-text">
      {children}
    </h1>
  );
}

export function Subtitle({ children }: { children: ReactNode }) {
  return <p className="pb-6 text-body text-muted">{children}</p>;
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-body font-medium text-text">
        {label}
      </label>
      {children}
    </div>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean };

export function Input({ mono, className = '', ...rest }: InputProps) {
  return (
    <input
      {...rest}
      className={
        'h-control w-full rounded-field border border-line bg-surface px-4 ' +
        'text-body text-text outline-none placeholder:text-dim ' +
        'focus:border-accent focus:ring-2 focus:ring-accent-soft ' +
        (mono ? 'font-mono tracking-[0.2em] text-center ' : '') +
        className
      }
    />
  );
}

export function Button({
  children,
  kind = 'primary',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'primary' | 'ghost';
}) {
  const base =
    'flex h-control w-full items-center justify-center rounded-pill ' +
    'text-body font-semibold transition-opacity disabled:opacity-50';
  const tone =
    kind === 'primary'
      ? 'bg-accent text-accent-ink'
      : 'border border-line bg-surface text-text';
  return (
    <button {...rest} className={`${base} ${tone} ${className}`}>
      {children}
    </button>
  );
}

/**
 * `role="alert"` so a screen reader announces a failed login without the
 * user having to hunt for it — the error is the whole feedback channel
 * on these screens.
 */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-body text-danger">
      {children}
    </p>
  );
}
