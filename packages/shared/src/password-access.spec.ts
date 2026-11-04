import {
  passwordAccessForCompany,
  readMembershipPasswordAccess,
  type PasswordAccessScope,
} from './password-access.js';

const X = 'company-x';
const Y = 'company-y';

describe('passwordAccessForCompany', () => {
  it.each<[PasswordAccessScope, string, boolean]>([
    [{ byDefault: true, allowCompanyIds: [], denyCompanyIds: [] }, X, true],
    [{ byDefault: false, allowCompanyIds: [], denyCompanyIds: [] }, X, false],
    [{ byDefault: true, allowCompanyIds: [], denyCompanyIds: [X] }, X, false],
    [{ byDefault: true, allowCompanyIds: [], denyCompanyIds: [X] }, Y, true],
    [{ byDefault: false, allowCompanyIds: [X], denyCompanyIds: [] }, X, true],
    [{ byDefault: false, allowCompanyIds: [X], denyCompanyIds: [] }, Y, false],
    // A company in both lists cannot happen (1 membership per company);
    // deny wins if it ever does.
    [{ byDefault: true, allowCompanyIds: [X], denyCompanyIds: [X] }, X, false],
  ])('%j for %s → %s', (scope, companyId, expected) => {
    expect(passwordAccessForCompany(scope, companyId)).toBe(expected);
  });
});

describe('readMembershipPasswordAccess', () => {
  it('keeps known values and falls back to inherit', () => {
    expect(readMembershipPasswordAccess('allow')).toBe('allow');
    expect(readMembershipPasswordAccess('deny')).toBe('deny');
    expect(readMembershipPasswordAccess('inherit')).toBe('inherit');
    expect(readMembershipPasswordAccess('ALLOW')).toBe('inherit');
    expect(readMembershipPasswordAccess(undefined)).toBe('inherit');
    expect(readMembershipPasswordAccess(null)).toBe('inherit');
  });
});
