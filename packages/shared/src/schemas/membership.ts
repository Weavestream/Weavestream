import { z } from 'zod';
import { MembershipRoleValues } from '../roles.js';
import { membershipPasswordAccessValues } from '../password-access.js';

const isoFutureDate = z
  .string()
  .datetime({ offset: true })
  .refine((v) => new Date(v).getTime() > Date.now(), 'expiresAt must be in the future');

const passwordAccess = z.enum(membershipPasswordAccessValues);

export const createMembershipSchema = z.object({
  userId: z.guid(),
  role: z.enum(MembershipRoleValues),
  expiresAt: isoFutureDate.nullable().optional(),
  passwordAccess: passwordAccess.optional(),
});

export const updateMembershipSchema = z
  .object({
    role: z.enum(MembershipRoleValues).optional(),
    expiresAt: isoFutureDate.nullable().optional(),
    passwordAccess: passwordAccess.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

// Bulk adds always create `inherit`; the override is set per member on the
// Members page (with step-up), never in bulk. Zod strips the omitted key.
const bulkMembershipItemSchema = createMembershipSchema.omit({ passwordAccess: true });

export const bulkCreateMembershipSchema = z.object({
  memberships: z
    .array(bulkMembershipItemSchema)
    .min(1)
    .max(100),
});

export type CreateMembershipInput = z.infer<typeof createMembershipSchema>;
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;
export type BulkCreateMembershipInput = z.infer<typeof bulkCreateMembershipSchema>;
