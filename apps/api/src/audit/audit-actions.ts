/**
 * Catalog of every audit action emitted by the API. The integration
 * coverage test iterates this list and asserts each action is produced
 * by the scripted flow. Adding a new action without wiring an emitter
 * will fail that test.
 */
export const AUDIT_ACTIONS = {
  auth: {
    loginSuccess: 'auth.login.success',
    loginFailure: 'auth.login.failure',
    logout: 'auth.logout',
    refresh: 'auth.refresh',
    mfaEnroll: 'auth.mfa.enroll',
    mfaEnrollComplete: 'auth.mfa.enroll.complete',
    mfaVerifySuccess: 'auth.mfa.verify.success',
    mfaVerifyFailure: 'auth.mfa.verify.failure',
    sessionsRevokeOthers: 'auth.sessions.revoke_others',
  },
  user: {
    create: 'user.create',
    update: 'user.update',
    roleChange: 'user.role.change',
    deactivate: 'user.deactivate',
    passwordChange: 'user.password.change',
    mfaReset: 'user.mfa.reset',
    inviteCreated: 'user.invite.created',
    inviteAccepted: 'user.invite.accepted',
  },
  company: {
    create: 'company.create',
    update: 'company.update',
    archive: 'company.archive',
    restore: 'company.restore',
  },
  membership: {
    create: 'membership.create',
    update: 'membership.update',
    revoke: 'membership.revoke',
  },
  settings: {
    update: 'settings.update',
  },
  domain: {
    create: 'domain.create',
    update: 'domain.update',
    archive: 'domain.archive',
    restore: 'domain.restore',
    check: 'domain.check',
  },
} as const;

export const ALL_AUDIT_ACTIONS: string[] = [
  ...Object.values(AUDIT_ACTIONS.auth),
  ...Object.values(AUDIT_ACTIONS.user),
  ...Object.values(AUDIT_ACTIONS.company),
  ...Object.values(AUDIT_ACTIONS.membership),
  ...Object.values(AUDIT_ACTIONS.settings),
  ...Object.values(AUDIT_ACTIONS.domain),
];
