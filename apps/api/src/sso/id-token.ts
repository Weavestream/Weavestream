import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { constantTimeEqual } from './sso-pkce.js';

/**
 * Signature algorithms an ID token may use. An allow-list, so `none` and every
 * HMAC algorithm (`HS*`, which would let anyone holding the public client id
 * forge a token) are refused before any key is consulted.
 */
export const ALLOWED_ID_TOKEN_ALGS = ['RS256', 'ES256', 'PS256'] as const;

/** Why an ID token was refused. Fixed codes only; never token content. */
export type IdTokenFailure =
  | 'invalid_token' // malformed, bad signature, wrong alg, wrong iss/aud/azp, missing claims
  | 'expired'
  | 'nonce_mismatch'
  | 'tenant_mismatch';

export class IdTokenError extends Error {
  constructor(
    readonly failure: IdTokenFailure,
    /** jose error code (e.g. ERR_JWT_EXPIRED) when there is one; safe to log. */
    readonly joseCode?: string,
  ) {
    super(failure);
    this.name = 'IdTokenError';
  }
}

/** The claims Weavestream uses, after verification. Everything else is dropped. */
export interface VerifiedIdToken {
  issuer: string;
  /** `sub`: stable per (issuer, client) but pairwise on Entra; see `oid`. */
  sub: string;
  /** Entra object id: stable per user across applications. */
  oid?: string;
  /** Entra tenant id. */
  tid?: string;
  email?: string;
  /** True only when the token says `email_verified: true`; an absent claim is NOT verified. */
  emailVerified: boolean;
  /** True only when the Entra `xms_edov` claim is true (the domain owner verified the email). */
  emailDomainOwnerVerified: boolean;
  name?: string;
  amr: string[];
  /** Seconds since the epoch of the user's last active authentication. */
  authTime?: number;
}

export interface VerifyIdTokenOptions {
  /** The configured issuer; the token's `iss` must equal it exactly. */
  issuer: string;
  /** This application's client id; the token's `aud` must contain it. */
  clientId: string;
  /** The nonce from the flow cookie. */
  nonce: string;
  /** When set, the token's `tid` must equal it (Entra tenant pin). */
  allowedTenantId?: string;
  /** Allowed clock skew in seconds. Default 60. */
  clockToleranceSec?: number;
}

/** Some providers send booleans as the string "true"; anything else is false. */
const isTrue = (v: unknown): boolean => v === true || v === 'true';

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/**
 * Verify an ID token received from the token endpoint. Claims are untrusted
 * until this returns: signature (against the issuer's keys via `getKey`),
 * `iss`, `aud`, `exp`, then `nonce` (constant-time) and, when configured,
 * `tid`. Throws {@link IdTokenError}.
 *
 * `getKey` is a jose key resolver (`createRemoteJWKSet` in production), kept
 * as a parameter so the verification can be tested against a local key pair.
 */
export async function verifyIdToken(
  idToken: string,
  getKey: JWTVerifyGetKey,
  opts: VerifyIdTokenOptions,
): Promise<VerifiedIdToken> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getKey, {
      issuer: opts.issuer,
      audience: opts.clientId,
      algorithms: [...ALLOWED_ID_TOKEN_ALGS],
      clockTolerance: opts.clockToleranceSec ?? 60,
      requiredClaims: ['exp', 'iat', 'sub'],
    }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const codeStr = typeof code === 'string' ? code : undefined;
    throw new IdTokenError(codeStr === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid_token', codeStr);
  }

  // OIDC Core 3.1.3.7: with several audiences, `azp` must name this client.
  const azp = asString(payload['azp']);
  if (azp !== undefined && azp !== opts.clientId) throw new IdTokenError('invalid_token');

  const nonce = asString(payload['nonce']);
  if (nonce === undefined || !constantTimeEqual(nonce, opts.nonce)) {
    throw new IdTokenError('nonce_mismatch');
  }

  const tid = asString(payload['tid']);
  if (opts.allowedTenantId !== undefined) {
    if (tid === undefined || tid.toLowerCase() !== opts.allowedTenantId.toLowerCase()) {
      throw new IdTokenError('tenant_mismatch');
    }
  }

  const sub = asString(payload.sub);
  if (sub === undefined) throw new IdTokenError('invalid_token');

  const amrRaw = payload['amr'];
  const amr = Array.isArray(amrRaw) ? amrRaw.filter((v): v is string => typeof v === 'string') : [];
  const authTime = payload['auth_time'];

  return {
    issuer: opts.issuer,
    sub,
    oid: asString(payload['oid']),
    tid,
    email: asString(payload['email']),
    emailVerified: isTrue(payload['email_verified']),
    emailDomainOwnerVerified: isTrue(payload['xms_edov']),
    name: asString(payload['name']),
    amr,
    authTime: typeof authTime === 'number' && Number.isFinite(authTime) ? authTime : undefined,
  };
}
