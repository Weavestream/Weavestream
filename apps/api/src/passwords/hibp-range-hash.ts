import { createHash } from 'node:crypto';

/**
 * Compute the uppercase SHA-1 hex digest used by the HIBP (Have I Been Pwned)
 * Pwned Passwords *range* API.
 *
 * SECURITY NOTE — This is **not** a password hash. WeaveStream never stores
 * passwords as SHA-1. The SHA-1 algorithm is mandated by the public HIBP
 * range protocol, which performs k-anonymity lookups by the first 5
 * characters of `SHA1(secret)` and returns matching suffixes for local
 * comparison. See: https://haveibeenpwned.com/API/v3#PwnedPasswords
 *
 * The digest is computed in-memory, queued only long enough for the worker
 * to perform the lookup, and is never persisted. At-rest password material
 * is protected by authenticated encryption (AES-GCM envelope) elsewhere in
 * this codebase.
 *
 * Static analyzers (CodeQL `js/insufficient-password-hash`) may flag this
 * because the input is named/derived from a password field. The flag is a
 * false positive: see SECURITY NOTE above.
 *
 * @param secret The plaintext to hash for HIBP range lookup.
 * @returns Uppercase 40-character hex SHA-1 digest.
 */
// codeql[js/insufficient-password-hash] HIBP range API requires SHA-1; not used for credential storage.
export function computeHibpRangeHash(secret: string): string {
  // codeql[js/insufficient-password-hash] HIBP range API requires SHA-1; not used for credential storage.
  return createHash('sha1').update(secret, 'utf8').digest('hex').toUpperCase();
}
