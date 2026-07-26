import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { Button } from './primitives';

/**
 * Loading / empty / error / offline states, defined **once**.
 *
 * `apps/web` has no shared version of any of these — one copy-pasted
 * local `SkeletonBar` that inlines its own keyframes per instance, and
 * eight independent `EmptyState` reimplementations. That drift is
 * exactly what the build plan's "defined once as shared primitives
 * rather than per-screen" is correcting, so these are new work rather
 * than a port.
 */

/**
 * Skeleton rows matching final row geometry.
 *
 * Rows, not a spinner: the handoff is explicit that lists never show a
 * spinner, because a skeleton at the real geometry means the layout
 * doesn't jump when data lands. Keyframes live in `globals.css` (and are
 * disabled under `prefers-reduced-motion`) rather than being inlined
 * here per instance.
 */
export function SkeletonList({
  rows = 5,
  variant = 'card',
}: {
  rows?: number;
  /** `card` = 74px password rows, `row` = 70px org/search rows. */
  variant?: 'card' | 'row';
}) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={
            'ws-skeleton rounded-card border border-line bg-surface ' +
            (variant === 'card' ? 'h-card-min' : 'h-row-min')
          }
        />
      ))}
    </div>
  );
}

/** Centred line plus the relevant primary action. */
export function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <p className="text-body text-muted">{message}</p>
      {actionLabel && onAction && (
        <div className="w-full max-w-[220px]">
          <Button onClick={onAction}>{actionLabel}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Inline banner for "something here refused to load".
 *
 * The split worth preserving from desktop's `ErrorBanner`: a **toast**
 * is for a transient write failure, a **banner** is for a read that
 * failed and would otherwise disappear into a silent empty list.
 */
export function ErrorBanner({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-card border border-line bg-danger-soft p-3.5"
    >
      <Icon name="error" size={20} className="mt-0.5 text-danger" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-body font-medium text-text">{title}</div>
        {detail && (
          <div className="break-words font-mono text-meta text-muted">
            {detail}
          </div>
        )}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 text-body font-semibold text-accent-text"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Connection banner.
 *
 * v1 shows an honest "no connection" state rather than stale data —
 * nothing is cached to disk, because whether *metadata* may be persisted
 * is still an open decision and TanStack Query's persister cannot tell a
 * list query from a reveal query (CLAUDE.md).
 */
export function OfflineBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 rounded-card border border-line bg-panel-2 px-3.5 py-3"
    >
      <Icon name="wifi_off" size={20} className="text-muted" />
      <span className="text-body text-text-2">
        No connection. Changes are disabled until you’re back online.
      </span>
    </div>
  );
}

/** Shared wrapper so every screen orders its states the same way. */
export function ScreenStates({
  offline,
  error,
  children,
}: {
  offline?: boolean;
  error?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      {offline && <OfflineBanner />}
      {error}
      {children}
    </>
  );
}
