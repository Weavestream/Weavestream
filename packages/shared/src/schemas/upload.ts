import { z } from 'zod';

/**
 * Entities an Upload can be attached to. Used for the photos gallery
 * filter and for cascaded cleanup rules. Matches the `attached_to_type`
 * column shape in the `uploads` table.
 */
export const uploadAttachmentTypeSchema = z.enum([
  'asset',
  'article',
  'asset_field',
]);
export type UploadAttachmentType = z.infer<typeof uploadAttachmentTypeSchema>;

export const uploadFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\\0]+$/, 'Filename must not contain path separators or NUL bytes');

export const initUploadSchema = z.object({
  filename: uploadFilenameSchema,
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
  attachedToType: uploadAttachmentTypeSchema.optional(),
  attachedToId: z.string().uuid().optional(),
});

export const confirmUploadSchema = z.object({
  uploadId: z.string().uuid(),
  attachedToType: uploadAttachmentTypeSchema.optional(),
  attachedToId: z.string().uuid().optional(),
});

export const attachUploadSchema = z
  .object({
    attachedToType: uploadAttachmentTypeSchema.nullable().optional(),
    attachedToId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type InitUploadInput = z.infer<typeof initUploadSchema>;
export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;
export type AttachUploadInput = z.infer<typeof attachUploadSchema>;

/** Shape a FILE field value carries inside AssetFieldValue.value. */
export const fileFieldEntrySchema = z.object({
  uploadId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  isImage: z.boolean().optional(),
});
export type FileFieldEntry = z.infer<typeof fileFieldEntrySchema>;
