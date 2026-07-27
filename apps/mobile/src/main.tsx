import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import { App } from './App';
import { syncAccentFromCookie, watchAccent } from './lib/accent';

// Runs before the first React render, but still after first paint —
// the shell variant served by the `/m` route handler is what makes the
// accent correct on paint. See lib/accent.ts.
syncAccentFromCookie();
watchAccent();

// Service worker registration (Phase 3): a bundled module, never an
// inline script — the `/m` CSP is `script-src 'self'`. Prod-only so the
// vite dev server (different origin, no /m scope) never registers one;
// the dynamic import also keeps the virtual module out of Jest's graph.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void import('virtual:pwa-register').then(({ registerSW }) =>
    registerSW({ immediate: true }),
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from the shell');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
