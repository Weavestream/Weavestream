'use client';

/**
 * Root-level fallback for errors that escape the usual route segment
 * boundaries (including errors thrown inside the root `layout.tsx`).
 *
 * Next.js requires this component to render its own `<html>` / `<body>`
 * since the root layout may itself have crashed. Keep it self-contained:
 * no providers, no fonts, no data fetching — just enough to tell the user
 * something went wrong and give them a way out.
 *
 * No auto-retry polling. `reset()` only re-runs React's render pass; it
 * does NOT re-request the RSC stream, so a polling loop that calls
 * `reset()` after the API comes back just re-hits the same cached error
 * forever. A plain reload is the one thing that reliably recovers.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#0b0b0d',
          color: '#e5e5e7',
          fontFamily:
            'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 11,
              letterSpacing: 0.8,
              textTransform: 'uppercase',
              color: '#9a9aa2',
              marginBottom: 12,
            }}
          >
            Weavestream
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 8px' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#9a9aa2', fontSize: 14, lineHeight: 1.5, margin: '0 0 20px' }}>
            The app hit an unexpected error.
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
                background: '#c6ff3f',
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
                color: '#e5e5e7',
                border: '1px solid #2a2a30',
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
      </body>
    </html>
  );
}
