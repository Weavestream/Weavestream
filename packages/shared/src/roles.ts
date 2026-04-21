export const UserRoleValues = [
  'SUPER_ADMIN',
  'OPERATOR',
  'CONTRACTOR',
  'CLIENT_USER',
] as const;
export type UserRole = (typeof UserRoleValues)[number];

export const MembershipRoleValues = [
  'OPERATOR_FULL',
  'OPERATOR_READONLY',
  'CLIENT_ADMIN',
  'CLIENT_VIEWER',
] as const;
export type MembershipRole = (typeof MembershipRoleValues)[number];
