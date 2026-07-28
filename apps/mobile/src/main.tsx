import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import { App } from './App';
import { syncUiFromCookie, watchUiPrefs } from './lib/ui-prefs';

// Runs before the first React render, but still after first paint —
// the shell variant served by the `/m` route handler is what makes the
// theme + accent correct on paint. See lib/ui-prefs.ts.
syncUiFromCookie();
watchUiPrefs();

// Service worker registration (Phase 3): a bundled module, never an
// inline script — the `/m` CSP is `script-src 'self'`. Prod-only so the
// vite dev server (different origin, no /m scope) never registers one;
// the dynamic import also keeps the virtual module out of Jest's graph.
// Phase 5a: failures are no longer silent — onRegisterError covers
// module-load/register() failures, and the observer below covers a
// failed INSTALL, which never rejects registration (it just makes the
// worker redundant).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) =>
      registerSW({
        immediate: true,
        onRegisterError: (error) =>
          console.error('[m] sw registration failed', error),
        onRegisteredSW: (_url, registration) => {
          if (!registration) return;
          // Watch each installing worker; report ONLY the installing →
          // redundant transition, and stop watching the moment the
          // worker leaves 'installing' — a successfully installed
          // worker later going redundant is normal replacement, not an
          // install failure. (A worker superseded while still
          // installing also lands here — acceptable ambiguity.)
          const observe = (worker: ServiceWorker | null) => {
            if (!worker) return;
            const report = () =>
              console.error(
                '[m] sw install failed (installing worker became redundant)',
              );
            if (worker.state === 'redundant') return report(); // fast failure, already over
            if (worker.state !== 'installing') return; // already past install
            const onChange = () => {
              worker.removeEventListener('statechange', onChange); // first transition ends the watch
              if (worker.state === 'redundant') report();
            };
            worker.addEventListener('statechange', onChange);
          };
          observe(registration.installing);
          registration.addEventListener('updatefound', () =>
            observe(registration.installing),
          );
        },
      }),
    )
    .catch((error) =>
      console.error('[m] sw register module failed to load', error),
    );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from the shell');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
