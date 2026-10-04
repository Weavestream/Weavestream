import { z } from 'zod';
import { UserRoleValues } from '../roles.js';

/**
 * Response contracts for the Security Center reads (`GET /security/*`).
 * All of them are gated server-side by the `security.read` action. The API
 * builds these shapes with ISO string dates.
 */

export const loginActivityBucketSchema = z.object({
  identifier: z.string(),
  success: z.number().int(),
  failure: z.number().int(),
  lastSeen: z.string(),
});

export const loginActivityRowSchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  actorId: z.string().uuid().nullable(),
  actor: z
    .object({ id: z.string().uuid(), name: z.string(), email: z.string() })
    .nullable(),
  attemptedEmail: z.string().nullable(),
});

/** `GET /security/login-activity`. */
export const loginActivitySchema = z.object({
  windowHours: z.number().int(),
  since: z.string(),
  counts: z.object({
    success: z.number().int(),
    failure: z.number().int(),
    mfaFailure: z.number().int(),
  }),
  byIp: z.array(loginActivityBucketSchema),
  byEmail: z.array(loginActivityBucketSchema),
  recent: z.array(loginActivityRowSchema),
});

export const lockoutEntrySchema = z.object({
  identifier: z.string(),
  failures: z.number().int(),
  ttlSeconds: z.number().int().nullable(),
  locked: z.boolean(),
});

/** `GET /security/lockouts`. */
export const lockoutsResponseSchema = z.object({
  threshold: z.number().int(),
  windowMinutes: z.number().int(),
  ip: z.array(lockoutEntrySchema),
  email: z.array(lockoutEntrySchema),
});

/** One row of `GET /security/throttle-blocks`. */
export const throttleBlockEntrySchema = z.object({
  throttler: z.string(),
  tracker: z.string(),
  blockedUntil: z.string().nullable(),
  remainingMs: z.number(),
});

export const egressBlockRowSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  userAgent: z.string().nullable(),
  url: z.string().nullable(),
  hostname: z.string().nullable(),
  resolvedIps: z.array(z.string()),
  reason: z.string().nullable(),
  matchedCidr: z.string().nullable(),
});

/** `GET /security/egress-blocks`. */
export const egressBlocksResponseSchema = z.object({
  windowHours: z.number().int(),
  since: z.string(),
  total: z.number().int(),
  recent: z.array(egressBlockRowSchema),
});

/** `GET /security/whoami` — how the API attributed this request. */
export const connectionDiagnosticsSchema = z.object({
  /** The IP every per-IP control (lockout, throttle, IP-rules, audit)
   * attributes this request to. Resolved via `ipOf(req)`. */
  resolvedIp: z.string(),
  /** The raw TCP peer the API sees — normally the `web` container. */
  socketPeer: z.string(),
  /** Whether the API honored forwarding headers (peer on private
   * bridge). Reflects only the API↔peer hop; see interpretation. */
  peerTrusted: z.boolean(),
  /** `X-Forwarded-For` as the API received it (the single sanitized
   * entry the web tier emits), or null. */
  forwardedForReceived: z.string().nullable(),
  /** The raw inbound chain the web tier received from its immediate
   * upstream, forwarded display-only by the web tier for this endpoint.
   * Never used for attribution. */
  inboundForwardedFor: z.string(),
  /** `TRUST_PROXY_HOPS` from this API container's environment. The API
   * does not apply it; see `webTrustProxyHops` for the value in effect. */
  trustProxyHops: z.number().int(),
  /** The `TRUST_PROXY_HOPS` value the web tier applied when it resolved
   * this request's client IP, sent display-only for this endpoint. Null
   * when no valid value arrived from a private-bridge peer: an older web
   * container, a request that bypassed `web`, or an untrusted peer. */
  webTrustProxyHops: z.number().int().nullable(),
  /** Plain-English, non-overclaiming notes about this request's
   * attribution and (config-derived) deployment topology. */
  interpretation: z.array(z.string()),
});

/** One row of `GET /security/sessions` — an active, unrevoked session. */
export const securitySessionRowSchema = z.object({
  /** The opaque `Session.id` row id — never a bearer credential. */
  id: z.string().uuid(),
  ip: z.string(),
  userAgent: z.string(),
  mfaPending: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  user: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    role: z.enum(UserRoleValues),
    mfaEnabled: z.boolean(),
    mfaEnrolled: z.boolean(),
    isActive: z.boolean(),
  }),
});

export type LoginActivityBucket = z.infer<typeof loginActivityBucketSchema>;
export type LoginActivityRow = z.infer<typeof loginActivityRowSchema>;
export type LoginActivity = z.infer<typeof loginActivitySchema>;
export type LockoutEntry = z.infer<typeof lockoutEntrySchema>;
export type LockoutsResponse = z.infer<typeof lockoutsResponseSchema>;
export type ThrottleBlockEntry = z.infer<typeof throttleBlockEntrySchema>;
export type EgressBlockRow = z.infer<typeof egressBlockRowSchema>;
export type EgressBlocksResponse = z.infer<typeof egressBlocksResponseSchema>;
export type ConnectionDiagnostics = z.infer<typeof connectionDiagnosticsSchema>;
export type SecuritySessionRow = z.infer<typeof securitySessionRowSchema>;
