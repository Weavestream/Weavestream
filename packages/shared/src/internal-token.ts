/**
 * Shared secret plumbing for internal-only API endpoints (endpoints the
 * web container polls but no browser may reach — e.g. `GET
 * /api/v1/ip-rules/active`).
 *
 * The web tier presents a token in the `x-ws-internal-token` header; the
 * API's `InternalOnlyGuard` verifies it in addition to the private-peer
 * socket check. The token is DERIVED from the already-required
 * `COOKIE_SIGNING_KEY` (both containers see it via the shared `.env`), so
 * there is no new env var and the raw signing key never travels over HTTP.
 *
 * Isomorphic on purpose: `deriveInternalApiToken` uses Web Crypto
 * (`globalThis.crypto.subtle`), which exists in both Node and the Next.js
 * edge/proxy runtime, so this module is safe to re-export from the
 * client-safe `@weavestream/shared` barrel.
 */

/** Request header the web tier presents on internal-only API endpoints. */
export const INTERNAL_TOKEN_HEADER = 'x-ws-internal-token';

// Domain-separation label mixed into the HMAC so the derived token can
// never collide with any other use of COOKIE_SIGNING_KEY. Versioned so a
// future scheme change can coexist during a rollout.
const INTERNAL_TOKEN_LABEL = 'weavestream:internal-api-token:v1';

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Derive the internal-API token from a secret via HMAC-SHA256 over a fixed
 * domain-separation label. Deterministic: the same secret always yields the
 * same token, so the web sender and the API verifier agree with no shared
 * state beyond `COOKIE_SIGNING_KEY`.
 */
export async function deriveInternalApiToken(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(INTERNAL_TOKEN_LABEL),
  );
  return toHex(new Uint8Array(sig));
}
