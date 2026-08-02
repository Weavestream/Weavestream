import { companyBaseHref, companyCrumbs } from './company-crumbs';

const term = { one: 'Client', other: 'Clients', possessive: "Client's" };
const company = { id: 'c1', name: 'Enterprise Title' };

describe('companyCrumbs', () => {
  it('leads with the company as a pill pointing at the picker', () => {
    const [head, ...rest] = companyCrumbs(term, company);
    expect(head).toEqual({
      label: 'Enterprise Title',
      href: '/admin/companies',
      variant: 'pill',
      title: 'All Clients',
    });
    // The old leading `Clients` crumb is gone — the pill is the only
    // route to the picker from the trail now.
    expect(rest).toEqual([]);
  });

  it('folds the section into the pill and drops the detail crumbs', () => {
    const crumbs = companyCrumbs(
      term,
      company,
      { label: 'Assets', href: '/admin/companies/c1/assets' },
      { label: 'MacBook Pro', mono: true },
    );
    // One object in the row, whatever depth the caller describes: the
    // record's own name is already the <h1> below the trail.
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]?.section).toEqual({
      label: 'Assets',
      href: '/admin/companies/c1/assets',
    });
  });

  it('carries a section with no href of its own', () => {
    const crumbs = companyCrumbs(term, company, { label: 'Domains' });
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]?.section).toEqual({ label: 'Domains', href: undefined });
  });

  it('keeps an asset detail page scoped to its selected layout', () => {
    const crumbs = companyCrumbs(
      term,
      company,
      {
        label: 'Workstations',
        href: '/admin/companies/c1/layouts/workstations',
      },
      { label: 'MacBook Pro' },
    );
    expect(crumbs[0]?.section).toEqual({
      label: 'Workstations',
      href: '/admin/companies/c1/layouts/workstations',
    });
  });

  it('builds the company section href', () => {
    expect(companyBaseHref(company)).toBe('/admin/companies/c1');
  });
});
