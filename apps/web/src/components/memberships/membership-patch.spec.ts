import {
  fromLocalInputValue,
  membershipPatch,
  toLocalInputValue,
  type MembershipDraft,
} from './membership-patch';

const base: MembershipDraft = {
  role: 'FULL',
  expiresAtLocal: '2027-01-01T09:30',
  passwordAccess: 'inherit',
};

describe('membershipPatch', () => {
  it('is empty when nothing changed', () => {
    expect(membershipPatch(base, { ...base })).toEqual({});
  });

  it('carries only the changed fields', () => {
    expect(membershipPatch(base, { ...base, role: 'READONLY' })).toEqual({ role: 'READONLY' });
    expect(membershipPatch(base, { ...base, passwordAccess: 'deny' })).toEqual({
      passwordAccess: 'deny',
    });
    expect(membershipPatch(base, { ...base, expiresAtLocal: '' })).toEqual({ expiresAt: null });
  });

  it('sends a changed expiry as an ISO instant', () => {
    const patch = membershipPatch(base, { ...base, expiresAtLocal: '2027-02-01T10:00' });
    expect(patch).toEqual({ expiresAt: new Date('2027-02-01T10:00').toISOString() });
  });
});

describe('local datetime round-trip', () => {
  it('keeps the same instant through the input value (no UTC shift)', () => {
    const iso = '2027-03-04T05:06:00.000Z';
    expect(fromLocalInputValue(toLocalInputValue(iso))).toBe(iso);
  });

  it('maps no expiry to an empty input and back', () => {
    expect(toLocalInputValue(null)).toBe('');
    expect(fromLocalInputValue('')).toBeNull();
  });
});
