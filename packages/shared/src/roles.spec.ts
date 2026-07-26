import {
  activeMembershipFor,
  canReadCompany,
  canWriteCompany,
  effectiveCompanyAccess,
  hasAnyCapability,
  hasCapability,
  type MembershipLike,
  type ViewerLike,
} from './roles';

const CO = 'c0000000-0000-4000-8000-000000000001';
const OTHER = 'c0000000-0000-4000-8000-000000000002';

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

function viewer(over: Partial<ViewerLike>): ViewerLike {
  return {
    role: 'OPERATOR',
    globalAccess: 'NONE',
    platformCapabilities: [],
    memberships: [],
    ...over,
  };
}

describe('effectiveCompanyAccess', () => {
  it('SUPER_ADMIN is FULL everywhere, memberships or not', () => {
    const me = viewer({ role: 'SUPER_ADMIN', globalAccess: null });
    expect(effectiveCompanyAccess(me, CO)).toBe('FULL');
    expect(effectiveCompanyAccess(me, OTHER)).toBe('FULL');
  });

  it('an active membership wins with its own role', () => {
    const full = viewer({
      memberships: [{ role: 'FULL', expiresAt: null, company: { id: CO } }],
    });
    const readonly = viewer({
      memberships: [{ role: 'READONLY', expiresAt: FUTURE, company: { id: CO } }],
    });
    expect(effectiveCompanyAccess(full, CO)).toBe('FULL');
    expect(effectiveCompanyAccess(readonly, CO)).toBe('READONLY');
    // …but only for that company.
    expect(effectiveCompanyAccess(full, OTHER)).toBe('NONE');
  });

  it('matches BOTH membership shapes: nested company (web /me) and flat companyId (/auth/me)', () => {
    // This is the divergence that would otherwise zero out every mobile
    // permission gate: /auth/me returns { companyId }, /me returns
    // { company: { id } }. Both must resolve.
    const nested = viewer({
      memberships: [{ role: 'FULL', expiresAt: null, company: { id: CO } }],
    });
    const flat = viewer({
      memberships: [{ role: 'FULL', expiresAt: null, companyId: CO }],
    });
    expect(effectiveCompanyAccess(nested, CO)).toBe('FULL');
    expect(effectiveCompanyAccess(flat, CO)).toBe('FULL');
  });

  it('ignores expired memberships', () => {
    const me = viewer({
      globalAccess: 'READONLY',
      memberships: [{ role: 'FULL', expiresAt: PAST, companyId: CO }],
    });
    // Membership expired → OPERATOR falls back to the global tier.
    expect(effectiveCompanyAccess(me, CO)).toBe('READONLY');
  });

  it('OPERATOR falls back to globalAccess; other roles never do', () => {
    expect(effectiveCompanyAccess(viewer({ globalAccess: 'FULL' }), CO)).toBe('FULL');
    expect(effectiveCompanyAccess(viewer({ globalAccess: 'READONLY' }), CO)).toBe('READONLY');
    expect(effectiveCompanyAccess(viewer({ globalAccess: 'NONE' }), CO)).toBe('NONE');

    const contractor = viewer({ role: 'CONTRACTOR', globalAccess: 'FULL' });
    const client = viewer({ role: 'CLIENT_USER', globalAccess: 'FULL' });
    expect(effectiveCompanyAccess(contractor, CO)).toBe('NONE');
    expect(effectiveCompanyAccess(client, CO)).toBe('NONE');
  });

  it('null viewer is NONE', () => {
    expect(effectiveCompanyAccess(null, CO)).toBe('NONE');
    expect(effectiveCompanyAccess(undefined, CO)).toBe('NONE');
  });
});

describe('canReadCompany / canWriteCompany', () => {
  it('read = any access, write = FULL only', () => {
    const readonly = viewer({
      memberships: [{ role: 'READONLY', expiresAt: null, companyId: CO }],
    });
    expect(canReadCompany(readonly, CO)).toBe(true);
    expect(canWriteCompany(readonly, CO)).toBe(false);

    const full = viewer({
      memberships: [{ role: 'FULL', expiresAt: null, companyId: CO }],
    });
    expect(canWriteCompany(full, CO)).toBe(true);

    expect(canReadCompany(viewer({}), CO)).toBe(false);
  });
});

describe('activeMembershipFor', () => {
  it('returns the matching row and null otherwise', () => {
    const row: MembershipLike = { role: 'FULL', expiresAt: null, companyId: CO };
    const me = viewer({ memberships: [row] });
    expect(activeMembershipFor(me, CO)).toBe(row);
    expect(activeMembershipFor(me, OTHER)).toBeNull();
    expect(activeMembershipFor(null, CO)).toBeNull();
  });
});

describe('capabilities', () => {
  it('SUPER_ADMIN implicitly holds every capability', () => {
    const me = viewer({ role: 'SUPER_ADMIN' });
    expect(hasCapability(me, 'MEMBERSHIP_MANAGE')).toBe(true);
    expect(hasAnyCapability(me, ['BACKUP_MANAGE'])).toBe(true);
  });

  it('OPERATOR holds only what was granted', () => {
    const me = viewer({ platformCapabilities: ['AUDIT_READ'] });
    expect(hasCapability(me, 'AUDIT_READ')).toBe(true);
    expect(hasCapability(me, 'MEMBERSHIP_MANAGE')).toBe(false);
    expect(hasAnyCapability(me, ['AUDIT_READ', 'BACKUP_MANAGE'])).toBe(true);
    expect(hasAnyCapability(me, ['BACKUP_MANAGE'])).toBe(false);
  });

  it('null viewer holds nothing', () => {
    expect(hasCapability(null, 'AUDIT_READ')).toBe(false);
    expect(hasAnyCapability(undefined, ['AUDIT_READ'])).toBe(false);
  });
});
