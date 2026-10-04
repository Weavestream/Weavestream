/**
 * Query parsing, link building, and labels for the company photo
 * gallery (admin + portal). Framework-free so both routes and their
 * tests share one implementation.
 */

type SearchParam = string | string[] | undefined;

/** A single non-empty search param, or undefined. Arrays are ignored. */
export function readString(v: SearchParam): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > 0 ? v : undefined;
}

/** `1` / `true` (any case) → true; anything else → false. */
export function readBool(v: SearchParam): boolean {
  if (typeof v !== 'string') return false;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * The filters both surfaces accept. `includeNonLatest` is deliberately
 * not here: it is an admin audit toggle, so only the admin route reads
 * it (`readBool(sp.includeNonLatest)`) and the portal cannot pass it
 * through by spreading this object into `listPhotos`.
 */
export function readPhotoQuery(sp: Record<string, SearchParam>): {
  attachedToType?: string;
  attachedToId?: string;
  cursor?: string;
} {
  return {
    attachedToType: readString(sp.attachedToType),
    attachedToId: readString(sp.attachedToId),
    cursor: readString(sp.cursor),
  };
}

/**
 * Gallery URL for a filter state. Every value goes through
 * `URLSearchParams`, so a crafted `attachedToId` cannot add or override
 * parameters. Empty values are dropped, and no query yields `basePath`.
 */
export function buildPhotosHref(
  basePath: string,
  params: {
    attachedToType?: string;
    attachedToId?: string;
    includeNonLatest?: boolean;
    cursor?: string;
  },
): string {
  const q = new URLSearchParams();
  if (params.attachedToType) q.set('attachedToType', params.attachedToType);
  if (params.attachedToId) q.set('attachedToId', params.attachedToId);
  if (params.includeNonLatest) q.set('includeNonLatest', '1');
  if (params.cursor) q.set('cursor', params.cursor);
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/**
 * Human-facing label for an upload's `attachedToType`. The raw DB
 * values (asset / asset_field / article) don't match the vocabulary
 * we show in the filter bar: `asset` is a generic attachment to an
 * asset, while `asset_field` is a photo stored on a FILE field and is
 * what operators think of as "the asset's photo". Keep this mapping
 * in one place so the filter pills, tile badges, and the "open
 * source X" / "view all for this X" links stay consistent.
 */
export function attachmentLabel(attachedToType: string): string {
  switch (attachedToType) {
    case 'asset':
      return 'Attachment';
    case 'asset_field':
      return 'Asset';
    case 'article':
      return 'Article';
    default:
      return attachedToType.replace('_', ' ');
  }
}
