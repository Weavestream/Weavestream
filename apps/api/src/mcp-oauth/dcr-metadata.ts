import { z } from 'zod';
import { isAnyModeRedirect, isLoopbackRedirect } from './mcp-oauth.constants.js';

/**
 * What a dynamic client registration (RFC 7591) may ask for, in mode `any`:
 * a public client (no secret, no keys) that uses the authorization code flow
 * with PKCE, and redirects that pass the `any` rule. Everything else in the
 * request (`client_name`, `client_uri`, `software_id`, …) passes through for
 * the library to keep or drop.
 *
 * The library has no hook for this without an initial access token, so the
 * controller runs it on the parsed body before the library sees it.
 */
const ALLOWED_GRANTS = ['authorization_code', 'refresh_token'] as const;

export const dcrMetadataSchema = z
  .looseObject({
    redirect_uris: z
      .array(z.string())
      .min(1, 'redirect_uris must list at least one URI')
      .refine((uris) => uris.every(isAnyModeRedirect), {
        message: 'redirect_uris must be https, or http on a loopback address (127.0.0.1, [::1], localhost)',
      }),
    token_endpoint_auth_method: z
      .literal('none', { message: 'token_endpoint_auth_method must be none (public clients only)' })
      .optional(),
    grant_types: z
      .array(z.enum(ALLOWED_GRANTS, { message: 'grant_types may only contain authorization_code and refresh_token' }))
      .refine((g) => g.includes('authorization_code'), {
        message: 'grant_types must include authorization_code',
      })
      .optional(),
    response_types: z
      .array(z.string())
      .refine((r) => r.length === 1 && r[0] === 'code', { message: 'response_types must be ["code"]' })
      .optional(),
    application_type: z.enum(['web', 'native'], { message: 'application_type must be web or native' }).optional(),
  })
  .refine((m) => !('client_secret' in m), { message: 'client_secret is not accepted' })
  .refine((m) => !('jwks' in m) && !('jwks_uri' in m), { message: 'jwks and jwks_uri are not accepted' });

export type DcrCheck =
  | { ok: true; metadata: Record<string, unknown> }
  | { ok: false; error: 'invalid_client_metadata'; error_description: string };

/**
 * Check a registration request. On success, the returned metadata is what the
 * library registers: a client with a loopback redirect is registered as
 * `native`, which turns on the library's own rule that accepts any port on a
 * loopback redirect at authorization time (RFC 8252 §7.3).
 */
export function checkDcrMetadata(body: unknown): DcrCheck {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      error_description: 'client registration request must be a JSON object',
    };
  }
  const parsed = dcrMetadataSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      error_description: parsed.error.issues[0]?.message ?? 'invalid client metadata',
    };
  }
  const metadata: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (parsed.data.redirect_uris.some(isLoopbackRedirect)) metadata.application_type = 'native';
  return { ok: true, metadata };
}
