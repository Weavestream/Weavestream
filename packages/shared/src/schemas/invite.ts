import { z } from 'zod';
import { passwordSchema } from './user.js';

/** base64url tokens are 43 chars for 32 bytes. Keep a generous bound. */
export const setupTokenSchema = z
  .string()
  .min(20)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Token must be base64url');

export const acceptInviteSchema = z.object({
  token: setupTokenSchema,
  password: passwordSchema,
});

export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
