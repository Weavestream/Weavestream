import { useQuery } from '@tanstack/react-query';
import { fetchRelations, type RelationEntityType } from './api';

/**
 * Linked items for one entity's detail screen. Keyed
 * `['relations', companyId, entityType, entityId]` — the prefix never
 * collides with `'org-scope'`/`'me'`, so the org switcher's predicate
 * invalidation evicts these automatically on a switch.
 */
export function useRelations(
  companyId: string | null,
  entityType: RelationEntityType,
  entityId: string,
) {
  return useQuery({
    queryKey: ['relations', companyId, entityType, entityId] as const,
    queryFn: () => fetchRelations(companyId!, entityType, entityId),
    enabled: companyId !== null,
  });
}
