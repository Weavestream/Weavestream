import { z } from 'zod';
import { tiptapDocSchema } from './article.js';

/**
 * Phase 10 — Zod schemas for the password vault.
 *
 * Everything here is a wire schema: no ciphertext is ever carried across
 * the HTTP boundary from the client, and the reveal/detail shapes are
 * intentionally narrow so tooling (OpenAPI / types) can't accidentally
 * surface secrets in places they don't belong.
 */

export const passwordNameSchema = z.string().min(1).max(200);
export const passwordUsernameSchema = z.string().max(200).nullable();
export const passwordUrlSchema = z.string().max(2048).nullable();
export const passwordColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #RRGGBB hex string')
  .nullable();

export const totpAlgoSchema = z.enum(['SHA1', 'SHA256', 'SHA512']);

/**
 * TOTP block. `secret` is a base32-encoded shared secret as produced by
 * an authenticator (RFC 4648). When present, the API accepts the full
 * configuration; `period` and `digits` default match the otplib defaults
 * and what every mainstream authenticator expects.
 */
export const totpConfigSchema = z.object({
  secret: z
    .string()
    .regex(/^[A-Z2-7=\s]+$/i, 'TOTP secret must be base32')
    .min(8)
    .max(256)
    .transform((v) => v.replace(/\s+/g, '').toUpperCase()),
  algorithm: totpAlgoSchema.default('SHA1'),
  digits: z.number().int().min(6).max(10).default(6),
  period: z.number().int().min(15).max(300).default(30),
});

export type TotpConfigInput = z.infer<typeof totpConfigSchema>;

/**
 * Notes accept either a short plaintext string (common for simple
 * "remember this thing" notes) or a full Tiptap JSON doc for users who
 * paste in structured content. The API encrypts whichever shape arrives
 * at rest and renders it via RichTextView on the way out.
 */
export const passwordNotesSchema = z.union([z.string().max(50_000), tiptapDocSchema]);

export const passwordTagsSchema = z
  .array(z.string().min(1).max(40))
  .max(32)
  .default([])
  .transform((tags) => Array.from(new Set(tags.map((t) => t.trim()))).filter(Boolean));

export const createPasswordSchema = z.object({
  name: passwordNameSchema,
  folderId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  username: z.string().max(200).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  password: z.string().min(1).max(1024),
  notes: passwordNotesSchema.nullable().optional(),
  totp: totpConfigSchema.nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #RRGGBB hex string')
    .nullable()
    .optional(),
  tags: passwordTagsSchema.optional(),
  visibleToClients: z.boolean().optional(),
  requireReasonToView: z.boolean().optional(),
  restrictedToUserIds: z.array(z.string().uuid()).max(64).optional(),
  rotationReminderDays: z.number().int().min(1).max(3650).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type CreatePasswordInput = z.infer<typeof createPasswordSchema>;

export const updatePasswordSchema = z
  .object({
    name: passwordNameSchema.optional(),
    folderId: z.string().uuid().nullable().optional(),
    assetId: z.string().uuid().nullable().optional(),
    username: z.string().max(200).nullable().optional(),
    url: z.string().trim().max(2048).nullable().optional(),
    password: z.string().min(1).max(1024).optional(),
    notes: passwordNotesSchema.nullable().optional(),
    totp: totpConfigSchema.nullable().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #RRGGBB hex string')
      .nullable()
      .optional(),
    tags: passwordTagsSchema.optional(),
    visibleToClients: z.boolean().optional(),
    requireReasonToView: z.boolean().optional(),
    restrictedToUserIds: z.array(z.string().uuid()).max(64).optional(),
    rotationReminderDays: z.number().int().min(1).max(3650).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    changeReason: z.string().max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;

export const revealPasswordSchema = z
  .object({
    reason: z.string().max(500).optional(),
    includeTotpSecret: z.boolean().optional(),
  })
  .default({});
export type RevealPasswordInput = z.infer<typeof revealPasswordSchema>;

/**
 * Shape returned by `GET /companies/:companyId/passwords` — list
 * endpoints NEVER carry any ciphertext or plaintext secret. `hasTotp`
 * is a derived boolean for the UI so list views can render the TOTP
 * chip without leaking the fact that a secret is configured via
 * length-in-bytes side channels.
 */
export const passwordSummarySchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
  assetId: z.string().uuid().nullable(),
  name: passwordNameSchema,
  username: z.string().nullable(),
  url: z.string().nullable(),
  color: z.string().nullable(),
  tags: z.array(z.string()),
  hasTotp: z.boolean(),
  passwordStrength: z.number().int().min(0).max(4).nullable(),
  pwnedCount: z.number().int().min(0).nullable(),
  lastRotatedAt: z.string().datetime({ offset: true }).nullable(),
  rotationReminderDays: z.number().int().nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  visibleToClients: z.boolean(),
  requireReasonToView: z.boolean(),
  restrictedToUserIds: z.array(z.string().uuid()),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  createdBy: z.string().uuid(),
  updatedBy: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type PasswordSummary = z.infer<typeof passwordSummarySchema>;

/**
 * Detail returned by `GET /passwords/:id` — carries the DECRYPTED
 * notes (authorized readers already have `password.read`). The
 * password itself + TOTP secret still require an explicit reveal call.
 */
export const passwordDetailSchema = passwordSummarySchema.extend({
  notes: passwordNotesSchema.nullable(),
  totpAlgorithm: totpAlgoSchema,
  totpDigits: z.number().int(),
  totpPeriod: z.number().int(),
});
export type PasswordDetail = z.infer<typeof passwordDetailSchema>;

/**
 * Reveal response. `totpSecret` is only populated when
 * `includeTotpSecret: true` was sent AND the record actually has one.
 */
export const passwordRevealResponseSchema = z.object({
  password: z.string(),
  totpSecret: z.string().optional(),
});
export type PasswordRevealResponse = z.infer<typeof passwordRevealResponseSchema>;

/**
 * `POST /passwords/:id/totp` response — a live code + validity window.
 * `validUntil` drives the countdown ring in the UI.
 */
export const passwordTotpResponseSchema = z.object({
  code: z.string(),
  algorithm: totpAlgoSchema,
  digits: z.number().int(),
  period: z.number().int(),
  validUntil: z.string().datetime({ offset: true }),
});
export type PasswordTotpResponse = z.infer<typeof passwordTotpResponseSchema>;

export const passwordVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  changedFields: z.array(z.string()),
  changedBy: z.string().uuid(),
  changedByName: z.string().nullable(),
  changeReason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type PasswordVersionSummary = z.infer<typeof passwordVersionSummarySchema>;

export const passwordFilterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  folderId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  tag: z.string().max(40).optional(),
  archived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  stale: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
});
export type PasswordFilterInput = z.infer<typeof passwordFilterSchema>;
