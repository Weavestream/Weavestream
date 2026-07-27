import type { SearchHit } from '@weavestream/shared';
import type { IconName } from '../../components/Icon';

/**
 * Client-side grouping for the search screen. The API returns one flat,
 * relevance-ordered array; the design groups it by record type with
 * `"Passwords · 3"` headers — counts of the hits actually returned,
 * never `SearchResponse.total`, which is always null when there are
 * hits (the server runs no count query).
 */

export interface SearchGroup {
  kind: 'password' | 'asset' | 'article';
  icon: IconName;
  /** `"Passwords · 3"` — the design's mono-uppercase group header. */
  label: string;
  hits: SearchHit[];
}

/** Display order from the handoff: Passwords, Assets, Articles. */
const GROUPS = [
  { kind: 'password', icon: 'lock', noun: 'Passwords' },
  { kind: 'asset', icon: 'dns', noun: 'Assets' },
  { kind: 'article', icon: 'description', noun: 'Articles' },
] as const;

export function groupHits(items: readonly SearchHit[]): SearchGroup[] {
  return GROUPS.flatMap(({ kind, icon, noun }) => {
    // Within a group, the server's relevance order is preserved.
    // Hits of any other kind (upload/domain — excluded via `types=`
    // but tolerated defensively) are dropped rather than rendered as
    // rows that could never open.
    const hits = items.filter((hit) => hit.kind === kind);
    if (hits.length === 0) return [];
    return [{ kind, icon, label: `${noun} · ${hits.length}`, hits }];
  });
}
