import { z } from 'zod';
import { companyLogoSchema } from './company.js';

/**
 * Response contract for `GET /me/stars` — one row per starred entity,
 * already hydrated with the names a dashboard panel shows, so the client
 * renders the list without a second round trip per row. Discriminated by
 * `type` so the frontend can render each with the right icon, link, and
 * sub-line, while keeping a single starredAt-sorted list.
 */

const starredBase = {
  id: z.string().uuid(),
  name: z.string(),
  archivedAt: z.string().nullable(),
  starredAt: z.string(),
  companyId: z.string().uuid(),
  companyName: z.string(),
};

export const starredItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('company'),
    ...starredBase,
    slug: z.string(),
    memberCount: z.number().int(),
    logo: companyLogoSchema.nullable(),
  }),
  z.object({
    type: z.literal('password'),
    ...starredBase,
    companyArchivedAt: z.string().nullable(),
  }),
  z.object({
    type: z.literal('asset'),
    ...starredBase,
    companyArchivedAt: z.string().nullable(),
    layoutName: z.string().nullable(),
    layoutIcon: z.string().nullable(),
  }),
  z.object({
    type: z.literal('article'),
    ...starredBase,
    slug: z.string(),
    companyArchivedAt: z.string().nullable(),
  }),
]);

export type StarredItem = z.infer<typeof starredItemSchema>;
