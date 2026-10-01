import { z } from 'zod';

/**
 * API keys authenticate as their creating user. They carry no authority of
 * their own: the permission engine runs unchanged against the owning user, so
 * a key is at most as capable as the human who minted it.
 *
 * `scopes` exists only to **narrow** that authority. It can never widen it —
 * an empty array means "inherit the user's permissions unchanged", which is
 * the default. A scope string names a capability the key is restricted to.
 */
export const apiKeyScopeSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(
    /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/,
    'Scope must be lowercase dot.separated (e.g. asset.read)',
  );

export const apiKeyNameSchema = z.string().min(1).max(80);

/**
 * Maximum lifetime a caller may request. Keys are not permitted to live
 * forever by accident: omitting `expiresInDays` applies the server default
 * (365 days), and `null` must be passed deliberately to opt out.
 */
export const MAX_API_KEY_DAYS = 3650;

export const createApiKeySchema = z.object({
  name: apiKeyNameSchema,
  scopes: z.array(apiKeyScopeSchema).max(50).optional(),
  /**
   * Days until expiry. Omit for the server default; pass `null` to create a
   * non-expiring key (deliberate opt-out, not a default).
   */
  expiresInDays: z.number().int().min(1).max(MAX_API_KEY_DAYS).nullable().optional(),
  /**
   * Permit this key to decrypt stored credentials. Defaults to false and must
   * be set deliberately: a key that can drain the vault is a different class
   * of credential from one that can read asset documentation.
   */
  allowPasswordReveal: z.boolean().optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/**
 * Shape returned when listing keys. Deliberately omits `tokenHash` — it has no
 * caller outside verification, and a hash of a live credential should not be
 * handed to a client even though it is not directly usable.
 */
export interface ApiKeySummary {
  id: string;
  keyId: string;
  name: string;
  scopes: string[];
  /** Whether this key may decrypt stored credentials. The thing to audit. */
  allowPasswordReveal: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Creation response. `token` is delivered exactly once and is unrecoverable
 * afterwards — permitted under the one-time-delivery carve-out in CLAUDE.md §2
 * (server-generated for this authorized request, never reflected from the
 * request body, never logged, and the mint is audited by id rather than value).
 */
export interface CreatedApiKey extends ApiKeySummary {
  token: string;
}
