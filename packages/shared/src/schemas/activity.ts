import { z } from 'zod';

/** One row of `GET /activity/recent` — the operator home "Recent activity" feed. */
export const recentActivityItemSchema = z.object({
  type: z.enum(['asset', 'article']),
  id: z.string().uuid(),
  name: z.string(),
  companyId: z.string().uuid(),
  companyName: z.string(),
  companySlug: z.string(),
  /**
   * Synthetic verb derived from `createdAt` vs `updatedAt` — `created`
   * when the row hasn't been touched since insertion, `updated`
   * otherwise. Cheap signal; richer actions (archive/move/etc.) would
   * require trawling the audit log.
   */
  action: z.enum(['created', 'updated']),
  updatedAt: z.string(),
  updatedByName: z.string().nullable(),
});

export type RecentActivityItem = z.infer<typeof recentActivityItemSchema>;
