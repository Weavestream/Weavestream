import type { SearchEntityKind } from '@weavestream/shared';

/**
 * Role-aware deep link for an entity — the single admin-vs-portal URL
 * builder, extracted from `SearchService.hrefFor` so the AI read tools
 * emit the same links the search palette does.
 *
 * Operators (SUPER_ADMIN, OPERATOR, CONTRACTOR) land on admin URLs,
 * clients on portal URLs. Portal asset detail pages don't exist yet,
 * so client asset hits route to the layout's asset list page, which
 * does exist.
 */
export interface EntityHrefInput {
  kind: SearchEntityKind;
  entityId: string;
  companyId: string;
  companySlug: string;
  layoutSlug?: string | null;
  articleSlug?: string | null;
  isClient: boolean;
}

export function entityHrefFor(input: EntityHrefInput): string {
  const adminBase = `/admin/companies/${input.companyId}`;
  const portalBase = `/portal/${input.companySlug}`;
  const base = input.isClient ? portalBase : adminBase;
  switch (input.kind) {
    case 'asset':
      if (input.isClient && input.layoutSlug) {
        return `${base}/layouts/${input.layoutSlug}`;
      }
      return `${base}/assets/${input.entityId}`;
    case 'article':
      if (input.isClient && input.articleSlug) {
        return `${base}/articles/${input.articleSlug}`;
      }
      return `${base}/articles/${input.entityId}`;
    case 'upload':
      return `${base}/photos`;
    case 'domain':
      // Portal currently renders a read-only list only; operators get
      // a detail page. Both live under `/domains/:id` so the same
      // route works in either role.
      return `${base}/domains/${input.entityId}`;
    case 'password':
      // Same path shape in admin + portal — the password detail page
      // exists in both routers and enforces its own visibility rules.
      return `${base}/passwords/${input.entityId}`;
  }
}

/** Company overview page for the acting role. */
export function companyHrefFor(input: {
  companyId: string;
  companySlug: string;
  isClient: boolean;
}): string {
  return input.isClient
    ? `/portal/${input.companySlug}`
    : `/admin/companies/${input.companyId}`;
}
