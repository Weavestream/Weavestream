import { useEffect, useState } from 'react';

/**
 * Whether the browser thinks it has a connection.
 *
 * **A hint, not a verdict.** `navigator.onLine` reports `true` for any
 * attached network, including a captive portal that answers every request
 * with a login page — which is a very ordinary situation in a client's
 * building. So this drives an advisory banner and disables mutations; the
 * authoritative signal is still a request that actually failed, surfaced
 * by the query's own error state.
 *
 * Defaults to online when the property is missing, so an environment
 * without it (jsdom without a stub) doesn't render a permanent banner.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
