import type { SearchEntityKind } from '@weavestream/shared';

/**
 * Map a search hit to the mobile route that can open it.
 *
 * `SearchHit.href` is DESKTOP-shaped — the API precomputes
 * `/admin/companies/…` or `/portal/…` paths for the web palette — so
 * mobile must never navigate it. This map is the only translation, and
 * it deliberately knows nothing but `kind` + `id`.
 *
 * `upload` and `domain` return null: mobile has no screen for either
 * (the search query also excludes them via `types=`, so a null here is
 * defense in depth, not a reachable dead end).
 */
export function routeForHit(kind: SearchEntityKind, id: string): string | null {
  switch (kind) {
    case 'password':
      return `/passwords/${id}`;
    case 'asset':
      return `/assets/${id}`;
    case 'article':
      return `/articles/${id}`;
    default:
      return null;
  }
}
