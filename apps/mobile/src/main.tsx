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

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from the shell');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
