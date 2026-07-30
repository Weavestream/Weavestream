import { useQuery } from '@tanstack/react-query';
import { fetchAttachments, type AttachmentEntityType } from './api';

/**
 * One entity's attachments. Keyed
 * `['attachments', companyId, entityType, entityId]` — the prefix
 * never collides with `'org-scope'`/`'me'`, so the org switcher's
 * predicate invalidation evicts these automatically on a switch, the
 * same contract `useRelations` relies on.
 */
export function useAttachments(
  companyId: string | null,
  entityType: AttachmentEntityType,
  entityId: string,
) {
  return useQuery({
    queryKey: ['attachments', companyId, entityType, entityId] as const,
    queryFn: () => fetchAttachments(companyId!, entityType, entityId),
    enabled: companyId !== null,
  });
}
