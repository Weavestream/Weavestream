import type { ReactNode } from 'react';

/**
 * Label + control + hint/error block for form screens.
 *
 * Promoted out of `PasswordFormScreen` in Phase 2c — the dynamic asset
 * field editors render one of these per layout field, and the password
 * form keeps using the same markup. The label is the mono uppercase
 * section style every form screen uses; the optional `error` renders
 * below the control as a `role="alert"` line (server validation issues
 * are mapped per-field onto it).
 */
export function FieldBlock({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.75">
      <label
        htmlFor={htmlFor}
        className="font-mono text-section uppercase tracking-[0.1em] text-muted"
      >
        {label}
      </label>
      {children}
      {error && <FieldError message={error} />}
      {hint && !error && <Hint>{hint}</Hint>}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-snug text-muted">{children}</p>;
}

export function FieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-[13px] leading-snug text-danger">
      {message}
    </p>
  );
}
