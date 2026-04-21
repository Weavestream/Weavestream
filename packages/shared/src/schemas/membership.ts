import { z } from 'zod';
import { MembershipRoleValues } from '../roles.js';

const isoFutureDate = z
  .string()
  .datetime({ offset: true })
  .refine((v) => new Date(v).getTime() > Date.now(), 'expiresAt must be in the future');

export const createMembershipSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(MembershipRoleValues),
  expiresAt: isoFutureDate.nullable().optional(),
});

export const updateMembershipSchema = z
  .object({
    role: z.enum(MembershipRoleValues).optional(),
    expiresAt: isoFutureDate.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export const bulkCreateMembershipSchema = z.object({
  memberships: z
    .array(createMembershipSchema)
    .min(1)
    .max(100),
});

export type CreateMembershipInput = z.infer<typeof createMembershipSchema>;
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;
export type BulkCreateMembershipInput = z.infer<typeof bulkCreateMembershipSchema>;
