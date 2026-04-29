import { z } from 'zod';

/**
 * IP allow/deny rules schema.
 *
 * CIDR validation uses a regex that accepts:
 *   - Single IPv4: "192.168.1.1"
 *   - IPv4 CIDR: "10.0.0.0/8", "192.168.0.0/16"
 *
 * The IpRuleGuard reads enabled rules ordered by priority and returns
 * the first match. If no rules match, access is allowed (default-allow).
 */

export const ipRuleActionValues = ['ALLOW', 'DENY'] as const;
export const ipRuleActionSchema = z.enum(ipRuleActionValues);
export type IpRuleAction = z.infer<typeof ipRuleActionSchema>;

// IPv4 CIDR regex: matches 1-3 digits . 1-3 digits . 1-3 digits . 1-3 digits
// optionally followed by / and 1-2 digits (0-32)
const ipv4CidrRegex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/(?:3[0-2]|[1-2][0-9]|[0-9]))?$/;

const cidrSchema = z
  .string()
  .trim()
  .min(1, 'CIDR is required')
  .max(18, 'CIDR too long')
  .refine(
    (v) => ipv4CidrRegex.test(v),
    'Must be a valid IPv4 address or CIDR (e.g., 192.168.1.1 or 10.0.0.0/8)',
  );

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
  cidr: cidrSchema,
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
    cidr: cidrSchema.optional(),
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
