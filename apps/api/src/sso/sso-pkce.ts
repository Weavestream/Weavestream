import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The three one-time secrets of an authorization-code request, all drawn from
 * `crypto.randomBytes` (CLAUDE.md §4): never `Math.random`, never derived from
 * time or from anything the client supplied.
 *
 * - `state`    binds the callback to the browser that started the flow (CSRF).
 * - `nonce`    binds the ID token to this request (replay).
 * - `verifier` is the PKCE code verifier; only its S256 `challenge` goes to
 *              the identity provider, the verifier itself stays in the signed
 *              flow cookie until the code is exchanged.
 */
export interface AuthRequestSecrets {
  state: string;
  nonce: string;
  verifier: string;
  challenge: string;
}

/** 32 random bytes, base64url: 43 characters, the RFC 7636 minimum length. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** RFC 7636 `S256`: base64url(SHA-256(verifier)), unpadded. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newAuthRequestSecrets(): AuthRequestSecrets {
  const verifier = randomToken();
  return {
    state: randomToken(),
    nonce: randomToken(),
    verifier,
    challenge: pkceChallenge(verifier),
  };
}

/**
 * Constant-time string comparison for secrets (state, nonce). Both sides are
 * hashed first so `timingSafeEqual` always sees equal-length buffers and the
 * comparison time does not reveal the length of either value.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
