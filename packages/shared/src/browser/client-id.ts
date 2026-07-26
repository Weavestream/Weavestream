let fallbackCounter = 0;

/**
 * Browser-only temporary id for React keys, draft rows, and drag/drop state.
 * `crypto.randomUUID()` is hidden on non-secure LAN origins, but
 * `getRandomValues()` remains available in the browsers we support there.
 *
 * No `'use client'` directive: this module is shared with `apps/mobile`
 * (a plain Vite SPA, where the directive is meaningless) and lives in a
 * package the Nest API also depends on. The React Server Component
 * boundary is established by the *importing* file, so `apps/web`'s client
 * components keep their own directive and this stays framework-neutral.
 */
export function randomClientId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }
  fallbackCounter += 1;
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}
