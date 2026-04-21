import type { RelationEndpointKind } from '@weavestream/shared';

export type { RelationEndpointKind };

export interface LinkedItem {
  relationId: string;
  kind: RelationEndpointKind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  icon: string | null;
  color: string | null;
  relationType: string;
  direction: 'outgoing' | 'incoming';
  isFieldManaged: boolean;
  createdAt: string;
}

export interface ListRelatedResponse {
  items: LinkedItem[];
  groups: Record<RelationEndpointKind, LinkedItem[]>;
  totalCount: number;
}

/**
 * Shape of a `/search/mentions` result — re-declared client-side because
 * the API type lives in a Nest module that isn't bundled for the web.
 */
export interface MentionSearchItem {
  kind: RelationEndpointKind;
  id: string;
  title: string;
  companyId: string;
  companyName: string;
  folderId?: string | null;
  slug?: string | null;
  layoutIcon?: string | null;
  layoutColor?: string | null;
  updatedAt: string;
}
