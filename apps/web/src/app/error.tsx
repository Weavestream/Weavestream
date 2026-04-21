'use client';

/**
 * Route-segment error boundary. Catches anything thrown during the render
 * of a page under `/` that isn't the root layout (those are caught by
 * `global-error.tsx` instead). Rendered inside the root layout so the
 * user keeps the shell chrome.
 *
 * Deliberately minimal:
 *   - no auto-retry polling loop. `reset()` only retries the React render;
 *     it does NOT re-fetch server components, so polling + reset creates
 *     an infinite loop against a stale RSC payload. Manual reload is the
 *     only thing that actually recovers cleanly.
 *   - the real resilience for API flakiness lives in `serverApiFetch`,
 *     which transparently retries network errors over a ~5s budget.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'grid',
        placeItems: 'center',
        padding: '48px 24px',
      }}
    >
      <div style={{ maxWidth: 480, textAlign: 'center' }}>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: -0.3,
            margin: '0 0 8px',
            color: 'var(--text, inherit)',
          }}
        >
          Something went wrong
        </h1>
        <p
          style={{
            color: 'var(--muted, #9a9aa2)',
            fontSize: 14,
            lineHeight: 1.5,
            margin: '0 0 20px',
          }}
        >
          This page hit an unexpected error.
          {error.digest && (
            <>
              <br />
              <span
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11,
                }}
              >
                ref: {error.digest}
              </span>
            </>
          )}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '9px 16px',
              background: 'var(--accent, #c6ff3f)',
              color: '#0b0b0d',
              border: 0,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '9px 16px',
              background: 'transparent',
              color: 'var(--text, #e5e5e7)',
              border: '1px solid var(--border, #2a2a30)',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
