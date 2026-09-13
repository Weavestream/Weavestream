import { z } from 'zod';
import { parseIpv6Cidr, type Ipv6CidrRejection } from '../ip-match.js';

/**
 * IP allow/deny rules schema.
 *
 * CIDR validation accepts:
 *   - Single IPv4: "192.168.1.1"
 *   - IPv4 CIDR: "10.0.0.0/8", "192.168.0.0/16"
 *   - Single IPv6: "2001:db8::1" (compressed or full, any letter case)
 *   - IPv6 CIDR: "2001:db8::/32", "::/0"
 *
 * IPv4 input validates and is stored exactly as before. IPv6 input is
 * stored in canonical RFC 5952 form, so one address never appears under
 * two spellings. Families never cross when rules are matched:
 * `0.0.0.0/0` does not cover IPv6 clients — see `ip-match.ts`.
 *
 * The IpRuleGuard reads enabled rules ordered by priority and returns
 * the first match. If no rules match, access is allowed (default-allow).
 */

export const ipRuleActionValues = ['ALLOW', 'DENY'] as const;
export const ipRuleActionSchema = z.enum(ipRuleActionValues);
export type IpRuleAction = z.infer<typeof ipRuleActionSchema>;

// IPv4 CIDR regex: matches 1-3 digits . 1-3 digits . 1-3 digits . 1-3 digits
// optionally followed by / and 1-2 digits (0-32). Unchanged by IPv6
// support, so every IPv4 rule that validated before still does.
const ipv4CidrRegex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/(?:3[0-2]|[1-2][0-9]|[0-9]))?$/;
// The same address without a prefix, to tell a bad prefix apart from a
// bad address in the error message.
const ipv4AddressRegex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

// The longest valid input: a full-form IPv6 address with an IPv4 tail
// (45 characters) plus `/128`.
const MAX_CIDR_LENGTH = 49;

const CIDR_FORMAT_MESSAGE =
  'Enter an IPv4 or IPv6 address or CIDR range, for example 192.0.2.1, 10.0.0.0/8, 2001:db8::1, or 2001:db8::/32';

const IPV6_REJECTION_MESSAGES: Record<Ipv6CidrRejection, string> = {
  'not-ipv6': CIDR_FORMAT_MESSAGE,
  'zone-id': 'Remove the zone ID (the % suffix): IP rules match addresses, not network interfaces',
  'brackets-or-port': 'Enter the IPv6 address without brackets or a port',
  prefix: 'An IPv6 prefix length must be a whole number from 0 to 128',
  'ipv4-mapped':
    'Use the plain IPv4 form (for example 192.0.2.1): IPv4-mapped IPv6 clients already match IPv4 rules',
};

/**
 * One rule's IP or CIDR. Exported so the IP rules dialog can show the
 * message the API would return before the form is submitted.
 */
export const ipRuleCidrSchema = z
  .string()
  .trim()
  .min(1, 'Enter an IP address or CIDR range')
  .max(MAX_CIDR_LENGTH, 'Too long for an IP address or CIDR range')
  .superRefine((value, ctx) => {
    // Empty and oversized values already carry their own message.
    if (value.length === 0 || value.length > MAX_CIDR_LENGTH) return;
    if (ipv4CidrRegex.test(value)) return;
    if (!value.includes(':')) {
      const [address, prefix] = value.split('/');
      const badPrefixOnly =
        prefix !== undefined && address !== undefined && ipv4AddressRegex.test(address);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: badPrefixOnly
          ? 'An IPv4 prefix length must be a whole number from 0 to 32'
          : CIDR_FORMAT_MESSAGE,
      });
      return;
    }
    const parsed = parseIpv6Cidr(value);
    if (!parsed.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: IPV6_REJECTION_MESSAGES[parsed.reason],
      });
    }
  })
  .transform((value) => {
    if (ipv4CidrRegex.test(value)) return value;
    const parsed = parseIpv6Cidr(value);
    return parsed.ok ? parsed.canonical : value;
  });

const prioritySchema = z.number().int().min(0).max(9999);

export const ipRuleSchema = z.object({
  id: z.string().uuid(),
  cidr: z.string(),
  action: ipRuleActionSchema,
  note: z.string().nullable(),
  priority: z.number().int(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type IpRule = z.infer<typeof ipRuleSchema>;

/**
 * Create input. CIDR is validated for format; overlaps are allowed
 * (admin decides which rule wins via priority).
 */
export const ipRuleInputSchema = z.object({
  cidr: ipRuleCidrSchema,
  action: ipRuleActionSchema,
  note: z
    .string()
    .trim()
    .max(500, 'Note too long')
    .optional()
    .nullable()
    .default(null),
  priority: prioritySchema.default(0),
  enabled: z.boolean().default(true),
});

export type IpRuleInput = z.infer<typeof ipRuleInputSchema>;

/**
 * PATCH input — every field optional, but at least one must be provided.
 */
export const ipRulePatchSchema = z
  .object({
    cidr: ipRuleCidrSchema.optional(),
    action: ipRuleActionSchema.optional(),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .nullable(),
    priority: prioritySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    'At least one field must be provided',
  );

export type IpRulePatch = z.infer<typeof ipRulePatchSchema>;

export const IP_RULE_ACTION_LABELS: Record<IpRuleAction, string> = {
  ALLOW: 'Allow',
  DENY: 'Deny',
};

/**
 * Internal web→API report of a page load denied by a DENY rule at the
 * Next.js proxy layer — the API never sees those requests, so the proxy
 * reports them for the security audit trail and alerting. Sent by
 * `apps/web/src/lib/ip-block-report.ts`, consumed by
 * `POST /ip-rules/blocked-report` behind `InternalOnlyGuard`.
 *
 * The blocked IP travels in the body — deliberately never in
 * `x-forwarded-for` — because `IpRuleGuard` evaluates the forwarded IP
 * on every request and would 403 the report itself. `ip` stays a loose
 * bounded string: the proxy's `'0.0.0.0'` unknown-client sentinel and
 * IPv6 forms must both pass.
 */
export const ipRuleBlockedReportSchema = z.object({
  ip: z.string().trim().min(1).max(64),
  cidr: z.string().trim().min(1).max(64),
  priority: z.number().int().min(0).max(9999).optional(),
  path: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
});

export type IpRuleBlockedReport = z.infer<typeof ipRuleBlockedReportSchema>;
