import { z } from 'zod';

/**
 * Phase 6 global & scoped search schemas. `GET /search` accepts the
 * `searchQuerySchema`-validated query and returns `SearchHit[]`. The
 * palette fetches a single page at a time — infinite scroll is done
 * via `offset`, not cursor-paginated, because tsvector result sets
 * are rebuilt each time anyway.
 *
 * `href` is pre-computed server-side so the palette can stay dumb:
 * operators see `/admin/…` routes, clients see `/portal/…` routes.
 */
export const searchEntityKinds = [
  'asset',
  'article',
  'upload',
  'domain',
  'password',
] as const;
export type SearchEntityKind = (typeof searchEntityKinds)[number];
export const searchEntityKindSchema = z.enum(searchEntityKinds);

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  companyId: z.string().uuid().optional(),
  types: z.array(searchEntityKindSchema).min(1).optional(),
  /**
   * Hudu's "Comprehensive Search" toggle. When on, appends a
   * prefix-match tsquery OR-ed with the base query so short tokens
   * (e.g. `admin` → `admin*`) match wider.
   */
  comprehensive: z.boolean().default(false),
  /**
   * Hudu's "Include museum items" toggle. When off (default) archived
   * rows are filtered out; when on they are returned with a score
   * penalty so active rows rank first.
   */
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10),
  /**
   * Capped to bound deep-pagination cost: a large `OFFSET` forces Postgres
   * into an O(n) scan-and-discard, so an attacker could pin DB CPU with a
   * tiny request. Real depth should move to keyset pagination.
   */
  offset: z.number().int().min(0).max(10_000).default(0),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Per-user palette defaults. Stored on `User.searchDefaults` as a
 * nullable JSONB column; a null column reads as `{ false, false }`.
 * A `PATCH /me` accepts either `null` to reset or a full object.
 */
export const userSearchDefaultsSchema = z.object({
  defaultComprehensive: z.boolean().default(false),
  defaultGlobal: z.boolean().default(false),
});

export type UserSearchDefaults = z.infer<typeof userSearchDefaultsSchema>;

export const userSearchDefaultsUpdateSchema = z
  .object({
    defaultComprehensive: z.boolean().optional(),
    defaultGlobal: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type UserSearchDefaultsUpdate = z.infer<
  typeof userSearchDefaultsUpdateSchema
>;

/**
 * A single search result row. The API precomputes `href` (role-aware),
 * `snippet` (may contain `<mark>…</mark>` wrappers around matching
 * tokens — clients must render through a sanitiser that only allows
 * `<mark>`), and minimal display metadata (`layoutIcon`, `slug`,
 * `thumbnailUrl`). `score` is the raw ts_rank_cd + recency blend and
 * is exposed mostly for debugging; the server already ordered the
 * results by it.
 */
export interface SearchHit {
  kind: SearchEntityKind;
  id: string;
  title: string;
  snippet: string;
  companyId: string;
  companyName: string;
  companySlug: string;
  updatedAt: string;
  archivedAt: string | null;
  href: string;
  layoutIcon?: string | null;
  layoutColor?: string | null;
  layoutName?: string | null;
  folderId?: string | null;
  slug?: string | null;
  thumbnailUrl?: string | null;
  mimeType?: string | null;
  score: number;
}

export interface SearchResponse {
  items: SearchHit[];
  total: number | null;
  comprehensive: boolean;
  includeArchived: boolean;
  companyId: string | null;
}
