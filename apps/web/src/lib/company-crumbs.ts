import type { Crumb } from '../components/shell/top-bar';
import type { Term } from './term';

/**
 * Canonical breadcrumb builder for every page under
 * `/admin/companies/[id]/**`. Until we had this helper the crumb
 * prefix was copy-pasted across roughly a dozen pages, which meant
 * subtle drift (some used `Admin` as the leading crumb, some omitted
 * it, some mistyped the company href). Funnelling through one helper
 * keeps the URL structure honest and makes future-term changes a
 * one-liner.
 *
 *   companyCrumbs(term, company)                       -> [ Acme ⌄ ]
 *   companyCrumbs(term, company, { label: 'Assets' })  -> [ Acme ⌄ | Assets ]
 *   companyCrumbs(term, company, { label: 'Assets', href: base + '/assets' }, { label: asset.name })
 *                                                      -> [ Acme ⌄ | Assets ]
 *
 * The header renders exactly one object: the scope pill. Its left half
 * is the company, chevron and all, pointing at the picker
 * (`/admin/companies`); its right half is the section ("Assets",
 * "Domains", a layout name) in the accent colour. The old leading
 * "Companies" crumb is gone — it duplicated the pill's own
 * destination, and the row is better spent on the search box. `term`
 * survives as the pill's tooltip, the only place the plural still
 * earns its keep here.
 *
 * Crumbs past the section are accepted and deliberately NOT rendered.
 * On a detail page the trailing crumb was always the record's own name
 * — the same string as the `<h1>` an inch below it — so the trail
 * spent a third of the row restating the heading. Callers keep passing
 * the full logical path (it is real information, and restoring depth
 * is a one-line change here rather than an edit across sixteen pages),
 * but the header shows only where you are, not what you're looking at.
 *
 * Two more things the pill quietly drops: `mono` on a section crumb
 * (no caller sets one — mono shows up on deeper crumbs like a layout
 * name or "New"), and the link to the company overview the old company
 * crumb carried. The pill's job is switching tenants; Home stays one
 * click away in the sidebar, which every company-scoped page renders.
 */
export function companyCrumbs(
  term: Term,
  company: { id: string; name: string },
  ...tail: Crumb[]
): Crumb[] {
  const [section] = tail;
  return [
    {
      label: company.name,
      href: '/admin/companies',
      variant: 'pill',
      title: `All ${term.other}`,
      ...(section
        ? { section: { label: section.label, href: section.href } }
        : {}),
    },
  ];
}

/**
 * Convenience: the current company section's href prefix. Use it
 * rather than open-coding `/admin/companies/${id}` across pages.
 */
export function companyBaseHref(company: { id: string }): string {
  return `/admin/companies/${company.id}`;
}
