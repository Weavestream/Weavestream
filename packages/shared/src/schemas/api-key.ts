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
  /**
   * Permit this key to change data. Defaults to false: a key is read-only
   * unless minted otherwise, so a leaked key can read but never modify or
   * delete. Enforced server-side by `ApiKeySurfaceGuard`.
   */
  allowWrite: z.boolean().optional(),
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
  /** Whether this key may change data. False = read-only. */
  allowWrite: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * One live key in the admin Security center list. Carries the owner so an
 * admin can see whose integration it is. Never the token or its hash.
 */
export interface AdminApiKeyRow extends ApiKeySummary {
  user: { id: string; name: string; email: string };
}

/**
 * One page of the admin key list. Offset pagination with a total, like the
 * audit log, so no live key is ever beyond the admin's reach.
 */
export interface AdminApiKeyPage {
  items: AdminApiKeyRow[];
  total: number;
  /** 1-based, clamped to the last page by the server. */
  page: number;
  pageSize: number;
}

export const ADMIN_API_KEY_PAGE_SIZES = [25, 50, 100] as const;
export const ADMIN_API_KEY_DEFAULT_PAGE_SIZE = 50;

/**
 * Creation response. `token` is delivered exactly once and is unrecoverable
 * afterwards — permitted under the one-time-delivery carve-out in CLAUDE.md §2
 * (server-generated for this authorized request, never reflected from the
 * request body, never logged, and the mint is audited by id rather than value).
 */
export interface CreatedApiKey extends ApiKeySummary {
  token: string;
}

/**
 * Changing your password and signing out other sessions both revoke every
 * API key the user holds (see `MeService`). Both routes report how many, so
 * the UI can tell the user which integrations just stopped.
 */
export interface ChangePasswordResult {
  ok: true;
  apiKeysRevoked: number;
}

export interface RevokeOtherSessionsResult {
  revoked: number;
  apiKeysRevoked: number;
}

/**
 * Shown before a password change or "sign out other sessions" is submitted.
 * One sentence, shared by web and mobile so the consequence reads the same
 * everywhere.
 */
export const API_KEY_REVOCATION_WARNING =
  'This also permanently revokes every API key you hold. Scripts and AI agents (MCP) that use them stop working until you create new keys.';

/**
 * Sentence appended to a success message when keys were revoked as a side
 * effect. Empty when none were, so callers can concatenate unconditionally.
 */
export function apiKeysRevokedNotice(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count === 1
    ? ' 1 API key revoked — create a new one for any script or AI agent that used it.'
    : ` ${count} API keys revoked — create new ones for any scripts or AI agents that used them.`;
}
