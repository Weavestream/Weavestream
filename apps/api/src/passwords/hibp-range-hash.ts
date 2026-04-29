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
 * The digest is computed in-memory and enqueued to BullMQ only long enough
 * for the worker to perform the lookup (`removeOnComplete: true`). Only the
 * first 5 hex chars (20 bits) ever leave the host — k-anonymity guarantees
 * ~1M+ candidate plaintexts share any given prefix. At-rest password
 * material is protected by authenticated encryption (AES-GCM envelope)
 * elsewhere in this codebase.
 *
 * CodeQL `js/insufficient-password-hash` (CWE-916) flags this because the
 * input is dataflow-tagged as a password. The query is intended for
 * credential-*storage* hashes; here the digest is a public-protocol
 * artefact. The alert is suppressed for this file via the path-scoped
 * `query-filters` entry in `.github/codeql/codeql-config.yml`.
 *
 * @param secret The plaintext to hash for HIBP range lookup.
 * @returns Uppercase 40-character hex SHA-1 digest.
 */
export function computeHibpRangeHash(secret: string): string {
  return createHash('sha1').update(secret, 'utf8').digest('hex').toUpperCase();
}
