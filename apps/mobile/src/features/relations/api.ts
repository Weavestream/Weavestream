import { apiFetch } from '../../lib/api';

/**
 * Minimal wire slice of the relations endpoint's `LinkedItem` — same
 * local-interface precedent as `CompanyRow` in org-scope. The server
 * also sends `href`, but that is a desktop path; mobile builds its own
 * navigation from `kind` + `id`.
 *
 * Lives in its own feature folder because passwords and articles both
 * render a Related section, and features must not import from each
 * other.
 */
export interface RelatedItem {
  relationId: string;
  kind: 'asset' | 'article' | 'password';
  id: string;
  title: string;
  subtitle: string | null;
}

export interface RelatedGroups {
  asset: RelatedItem[];
  article: RelatedItem[];
  password: RelatedItem[];
}

export type RelationEntityType = RelatedItem['kind'];

export async function fetchRelations(
  companyId: string,
  entityType: RelationEntityType,
  entityId: string,
): Promise<RelatedGroups> {
  const res = await apiFetch<{ groups?: Partial<RelatedGroups> }>(
    `/companies/${companyId}/relations?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`,
  );
  return {
    asset: res.groups?.asset ?? [],
    article: res.groups?.article ?? [],
    password: res.groups?.password ?? [],
  };
}
