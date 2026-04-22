import { z } from 'zod';

export const passwordFolderNameSchema = z.string().min(1).max(120);

export const createPasswordFolderSchema = z.object({
  name: passwordFolderNameSchema,
  parentId: z.string().uuid().nullable().optional(),
  icon: z.string().min(1).max(40).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #RRGGBB hex string')
    .nullable()
    .optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});
export type CreatePasswordFolderInput = z.infer<typeof createPasswordFolderSchema>;

export const updatePasswordFolderSchema = z
  .object({
    name: passwordFolderNameSchema.optional(),
    parentId: z.string().uuid().nullable().optional(),
    icon: z.string().min(1).max(40).nullable().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #RRGGBB hex string')
      .nullable()
      .optional(),
    position: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
export type UpdatePasswordFolderInput = z.infer<typeof updatePasswordFolderSchema>;

export const passwordFolderSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: passwordFolderNameSchema,
  icon: z.string().nullable(),
  color: z.string().nullable(),
  position: z.number().int(),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type PasswordFolderSchema = z.infer<typeof passwordFolderSchema>;
