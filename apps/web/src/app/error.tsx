'use client';

import { useEffect, useState } from 'react';
import {
  isApiUnavailableDigest,
  parseRateLimitDigest,
} from '../lib/api-errors';

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
 *
 * Two special cases, both recognized via `error.digest` (the only
 * server→client channel App Router keeps in production; constants and
 * parsers shared with the throw sites via `lib/api-errors`):
 *   - `RateLimitedError` smuggles the honoured cooldown through the
 *     digest → dedicated "please slow down" banner with an
 *     auto-enabling retry button.
 *   - `ApiUnavailableError` (backend unreachable or 5xx) → dedicated
 *     "can't reach the backend" page, so an outage never reads as a
 *     login problem or a generic crash (WS-021).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  if (isApiUnavailableDigest(error.digest)) {
    return <BackendUnavailablePanel />;
  }

  const rateLimitSeconds = parseRateLimitDigest(error.digest);
  if (rateLimitSeconds != null) {
    return <RateLimitedPanel seconds={rateLimitSeconds} />;
  }

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
            color: 'var(--muted, #8a8a8a)',
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
              // `--line-2` (the control/card token) rather than the
              // undefined `--border` this used to read: with a hardcoded
              // fallback the declaration stayed valid and quietly painted
              // one dark hex in both themes.
              border: '1px solid var(--line-2)',
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

/**
 * Renders when SSR could not reach the API at all (network-level
 * failure after `serverApiFetch`'s retry budget) or the API/proxy
 * answered 5xx. The one thing this page must communicate: the user's
 * session is fine — this is a server availability problem, not a login
 * problem. No auto-retry (see the file header); the Retry button does a
 * full reload, which re-runs SSR including the ~5s retry budget.
 */
function BackendUnavailablePanel() {
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
        <div
          aria-hidden
          style={{
            width: 44,
            height: 44,
            margin: '0 auto 14px',
            borderRadius: '50%',
            background: 'var(--warn-soft, rgba(255, 193, 7, 0.18))',
            color: 'var(--warn, #e2b247)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 20,
          }}
        >
          ⚠
        </div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: -0.2,
            margin: '0 0 8px',
            color: 'var(--text, inherit)',
          }}
        >
          Can&rsquo;t reach the backend
        </h1>
        <p
          style={{
            color: 'var(--muted, #8a8a8a)',
            fontSize: 13.5,
            lineHeight: 1.55,
            margin: '0 0 20px',
          }}
        >
          The web app couldn&rsquo;t reach the Weavestream API. You have
          not been signed out. This is a server availability issue, not
          a login problem. If it persists, ask your administrator to
          check that the API service is running.
          <br />
          <span
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              color: 'var(--dim, #858585)',
              marginTop: 8,
              display: 'inline-block',
            }}
          >
            ref: WS_API_UNAVAILABLE
          </span>
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '9px 16px',
            background: 'var(--accent, #c6ff3f)',
            color: '#fff',
            border: 0,
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            minWidth: 140,
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/**
 * Renders when the API returned HTTP 429 during SSR. We count down the
 * honoured cooldown client-side (it's metadata — no privileged info —
 * so we don't mind exposing it) and auto-enable a "Retry now" button
 * that triggers a full reload, which re-runs the RSC render from the
 * server and picks up fresh throttler budget.
 */
function RateLimitedPanel({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    if (remaining <= 0) return;
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  const ready = remaining <= 0;

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
        <div
          aria-hidden
          style={{
            width: 44,
            height: 44,
            margin: '0 auto 14px',
            borderRadius: '50%',
            background: 'var(--warn-soft, rgba(255, 193, 7, 0.18))',
            color: 'var(--warn, #e2b247)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 20,
          }}
        >
          ⏱
        </div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: -0.2,
            margin: '0 0 8px',
            color: 'var(--text, inherit)',
          }}
        >
          Slow down for a moment
        </h1>
        <p
          style={{
            color: 'var(--muted, #8a8a8a)',
            fontSize: 13.5,
            lineHeight: 1.55,
            margin: '0 0 20px',
          }}
        >
          The API is rate-limiting this session to protect the backend.
          No data was lost — your last action completed. You can retry in
          a moment.
          <br />
          <span
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              color: 'var(--dim, #858585)',
              marginTop: 8,
              display: 'inline-block',
            }}
          >
            {ready ? 'ready to retry' : `retry in ${remaining}s`}
          </span>
        </p>
        <button
          type="button"
          disabled={!ready}
          onClick={() => window.location.reload()}
          style={{
            padding: '9px 16px',
            background: ready
              ? 'var(--accent, #c6ff3f)'
              : 'var(--panel-2, #1a1a1f)',
            color: ready ? '#0b0b0d' : 'var(--dim, #858585)',
            // Same fix as the Reload button above. `--line-2` also stays
            // legible over the disabled fill; `--line` would vanish
            // against `--panel-2` in dark.
            border: ready ? 0 : '1px solid var(--line-2)',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: ready ? 'pointer' : 'not-allowed',
            minWidth: 140,
          }}
        >
          {ready ? 'Retry now' : 'Waiting…'}
        </button>
      </div>
    </div>
  );
}
