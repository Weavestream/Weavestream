import { z } from 'zod';
import { MembershipRoleValues, UserRoleValues } from '../roles.js';
import { userSearchDefaultsSchema } from './search.js';

/**
 * Password policy: 12+ chars, at least 3 of {lower, upper, digit, symbol}.
 * Matches the CLI policy so CLI-created admins and UI-created users share
 * the same bar.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password is too long')
  .refine((v) => classesOf(v) >= 3, {
    message:
      'Password must include at least 3 of: lowercase, uppercase, digit, symbol',
  });

function classesOf(v: string): number {
  let n = 0;
  if (/[a-z]/.test(v)) n++;
  if (/[A-Z]/.test(v)) n++;
  if (/\d/.test(v)) n++;
  if (/[^A-Za-z0-9]/.test(v)) n++;
  return n;
}

export const emailSchema = z.string().email().max(254);
export const nameSchema = z.string().min(1).max(120);
export const timezoneSchema = z.string().max(64);

/**
 * Phase 9b.2 — optional one-shot "invite into a company" payload.
 * When present, the users-service wraps user + membership creation in
 * a single transaction so the new user is never stranded without
 * access. `expiresAt` uses the same future-date constraint as the
 * standalone membership schema to keep the rules in one place.
 */
export const createUserMembershipSchema = z.object({
  companyId: z.string().uuid(),
  role: z.enum(MembershipRoleValues),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .refine(
      (v) => new Date(v).getTime() > Date.now(),
      'expiresAt must be in the future',
    )
    .nullable()
    .optional(),
});

export const createUserSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  role: z.enum(UserRoleValues),
  membership: createUserMembershipSchema.optional(),
});

export const updateUserSchema = z
  .object({
    name: nameSchema.optional(),
    role: z.enum(UserRoleValues).optional(),
    isActive: z.boolean().optional(),
    timezone: timezoneSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export const updateMeSchema = z
  .object({
    name: nameSchema.optional(),
    timezone: timezoneSchema.nullable().optional(),
    // Phase 6: per-user palette defaults. `null` resets the row to the
    // baseline (both toggles false); passing a partial object merges.
    searchDefaults: z.union([userSearchDefaultsSchema, z.null()]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type CreateUserMembershipInput = z.infer<typeof createUserMembershipSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
