import { companyShellNav } from './company-shell-nav';
import type { Me } from './server-api';

type Tenant = { id: string; name: string; slug: string };

const acme: Tenant = { id: 'c1', name: 'Acme', slug: 'acme' };
const borealis: Tenant = { id: 'c2', name: 'Borealis', slug: 'borealis' };

function viewer(
  over: Partial<Me> & { tenants?: Tenant[] } = {},
): Me {
  const { tenants = [acme], ...rest } = over;
  return {
    id: 'u1',
    name: 'Dana',
    email: 'dana@example.com',
    role: 'CLIENT_USER',
    globalAccess: 'NONE',
    platformCapabilities: [],
    memberships: tenants.map((company, i) => ({
      id: `m${i}`,
      role: 'VIEWER',
      company,
      expiresAt: null,
    })),
    ...rest,
  } as unknown as Me;
}

const client1 = viewer();
const client2 = viewer({ tenants: [borealis, acme] });
const operator = viewer({
  role: 'OPERATOR',
  globalAccess: 'FULL',
  tenants: [],
} as Partial<Me> & { tenants?: Tenant[] });

describe('companyShellNav — portal', () => {
  it('gives a multi-tenant client a switcher into /portal, never /admin', () => {
    const nav = companyShellNav(client2, acme, 'portal');
    expect(nav.switcherEntries?.map((e) => e.href)).toEqual([
      '/portal/acme',
      '/portal/borealis',
    ]);
    // Sorted by name, and the tenant they're in is marked.
    expect(nav.switcherEntries?.map((e) => e.name)).toEqual([
      'Acme',
      'Borealis',
    ]);
    expect(nav.switcherEntries?.find((e) => e.active)?.name).toBe('Acme');
    // The switcher owns the title, so no competing href — and the mark
    // is static too: `/` would round-trip through the last-company
    // cookie back into the tenant they're already in, so the popover is
    // the only control in the header that does anything.
    expect(nav.titleHref).toBeUndefined();
    expect(nav.homeHref).toBeUndefined();
  });

  it('leaves a single-tenant client with a static header', () => {
    const nav = companyShellNav(client1, acme, 'portal');
    expect(nav).toEqual({
      homeHref: undefined,
      titleHref: undefined,
      switcherEntries: null,
    });
  });

  it('routes an operator previewing the portal back to admin', () => {
    const nav = companyShellNav(operator, acme, 'portal');
    expect(nav.homeHref).toBe('/admin');
    expect(nav.titleHref).toBe('/admin/companies');
    expect(nav.switcherEntries).toBeNull();
  });

  it('prefers the in-portal switcher for an operator who also holds tenants', () => {
    const operatorWithTenants = viewer({
      role: 'OPERATOR',
      globalAccess: 'FULL',
      tenants: [acme, borealis],
    } as Partial<Me> & { tenants?: Tenant[] });
    const nav = companyShellNav(operatorWithTenants, acme, 'portal');
    expect(nav.switcherEntries).toHaveLength(2);
    expect(nav.titleHref).toBeUndefined();
  });

  it('gives a client no header href at all — only the switcher navigates', () => {
    for (const me of [client1, client2]) {
      const nav = companyShellNav(me, acme, 'portal');
      expect(nav.homeHref).toBeUndefined();
      expect(nav.titleHref).toBeUndefined();
    }
  });

  it('never hands an /admin href to a viewer without admin-shell access', () => {
    // The invariant, over every client-shaped viewer the portal can
    // render: nothing in the sidebar header escapes into /admin.
    for (const me of [client1, client2]) {
      const nav = companyShellNav(me, acme, 'portal');
      const hrefs = [
        nav.homeHref,
        nav.titleHref,
        ...(nav.switcherEntries ?? []).map((e) => e.href),
      ].filter((h): h is string => !!h);
      expect(hrefs.some((h) => h.startsWith('/admin'))).toBe(false);
    }
  });

  it('ignores expired memberships when counting tenants', () => {
    const expired = viewer({ tenants: [acme, borealis] });
    expired.memberships[1] = {
      ...expired.memberships[1]!,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    };
    const nav = companyShellNav(expired, acme, 'portal');
    // One live tenant left, so no switcher and nowhere to go.
    expect(nav.switcherEntries).toBeNull();
    expect(nav.homeHref).toBeUndefined();
  });
});

describe('companyShellNav — admin', () => {
  it('is one block pointing home, with no picker', () => {
    const nav = companyShellNav(operator, acme, 'admin');
    expect(nav).toEqual({
      homeHref: '/admin',
      titleHref: undefined,
      switcherEntries: null,
    });
  });
});
