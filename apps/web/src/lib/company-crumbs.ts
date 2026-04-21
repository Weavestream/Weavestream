import type { Crumb } from '../components/shell/top-bar';
import type { Term } from './term';

/**
 * Canonical breadcrumb builder for every page under
 * `/admin/companies/[id]/**`. Until we had this helper the three-
 * crumb prefix (term.other → company.name → section) was copy-
 * pasted across roughly a dozen pages, which meant subtle drift
 * (some used `Admin` as the leading crumb, some omitted it, some
 * mistyped the company href). Funnelling through one helper keeps
 * the URL structure honest and makes future-term changes a
 * one-liner.
 *
 *   companyCrumbs(term, company)                       -> [term, company]
 *   companyCrumbs(term, company, { label: 'Assets' })  -> [term, company, Assets]
 *   companyCrumbs(term, company, { label: 'Assets', href: base + '/assets' }, { label: asset.name })
 *
 * The first two crumbs are always clickable (they are the company
 * picker and the company overview, both of which exist). Trailing
 * crumbs are passed through verbatim so callers decide what should
 * be a link vs. a terminal label.
 */
export function companyCrumbs(
  term: Term,
  company: { id: string; name: string },
  ...tail: Crumb[]
): Crumb[] {
  return [
    { label: term.other, href: '/admin/companies' },
    { label: company.name, href: `/admin/companies/${company.id}` },
    ...tail,
  ];
}

/**
 * Convenience: the current company section's href prefix. Use it
 * rather than open-coding `/admin/companies/${id}` across pages.
 */
export function companyBaseHref(company: { id: string }): string {
  return `/admin/companies/${company.id}`;
}
