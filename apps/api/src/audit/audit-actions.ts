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
    emailUpdate: 'settings.email.update',
    emailTest: 'settings.email.test',
  },
  domain: {
    create: 'domain.create',
    update: 'domain.update',
    archive: 'domain.archive',
    restore: 'domain.restore',
    check: 'domain.check',
  },
  // Phase 10 — password vault. `revealed` rows always carry `actorId`,
  // `ip`, `userAgent`, and the optional `reason`; historical reveals
  // additionally record the `version` in the row's `after` JSON.
  // `versionRestored` captures the forward-only restore —
  // `after.fromVersion` names the source, the write itself is also
  // emitted as a regular `password.updated`. TOTP code generation is
  // intentionally NOT audited (the UI polls it every ~30s per visible
  // row); copying/revealing the underlying secret still routes through
  // `/reveal`, which is.
  password: {
    create: 'password.created',
    update: 'password.updated',
    revealed: 'password.revealed',
    archive: 'password.archived',
    restore: 'password.restored',
    versionRestored: 'password.version.restored',
    pwnedChecked: 'password.pwned.checked',
    folderCreate: 'password.folder.created',
    folderUpdate: 'password.folder.updated',
    folderArchive: 'password.folder.archived',
    folderRestore: 'password.folder.restored',
  },
  // Bulk PDF vault export. Triggered by SUPER_ADMIN only. The
  // `triggered` row is written by the API the moment the job is
  // enqueued so we have a record of intent even if the worker never
  // produces a PDF; `completed` is written by the worker once the file
  // is in MinIO and includes the byte size + whether plaintext
  // passwords were embedded. Both rows carry the same `exportId` in
  // `entityId` so the audit log groups them together.
  export: {
    triggered: 'export.triggered',
    completed: 'export.completed',
    failed: 'export.failed',
  },
  // Phase 11 — universal integration framework. The `integration.*` rows
  // are emitted by the global admin controller (no companyId). The
  // `integration.sync.*` rows can carry a companyId when the worker
  // writes the per-mapping result (`integration.sync.mapping.*`) so an
  // operator viewing their tenant's audit log sees every sync that
  // touched their data — even though they cannot manage the integration
  // itself. `integration.asset.*` rows are tenant-scoped and carry the
  // affected `assetId` for traceability of synced/claimed/archived rows.
  // Alerts feature. `fired` is written by the alerts worker after a
  // successful send so an admin can audit which configs are actually
  // emailing — `entityId` carries the AlertConfig id and `after`
  // carries `{ triggerKey, recipient }` for traceability.
  alert: {
    create: 'alert.create',
    update: 'alert.update',
    archive: 'alert.archive',
    test: 'alert.test',
    fired: 'alert.fired',
  },
  // Direct (non-integration) record CRUD. The integration sync path
  // continues to use `integration.asset.*` so the two streams stay
  // distinguishable in the audit log.
  asset: {
    create: 'asset.create',
    update: 'asset.update',
    archive: 'asset.archive',
    restore: 'asset.restore',
  },
  article: {
    create: 'article.create',
    update: 'article.update',
    move: 'article.move',
    archive: 'article.archive',
    restore: 'article.restore',
  },
  integration: {
    create: 'integration.create',
    update: 'integration.update',
    delete: 'integration.delete',
    secretUpdate: 'integration.secret.update',
    testConnection: 'integration.test_connection',
    companyMappingCreate: 'integration.company_mapping.create',
    companyMappingUpdate: 'integration.company_mapping.update',
    companyMappingDelete: 'integration.company_mapping.delete',
    fieldMappingsReplace: 'integration.field_mappings.replace',
    syncRunStarted: 'integration.sync.started',
    syncRunFinished: 'integration.sync.finished',
    syncRunFailed: 'integration.sync.failed',
    syncMappingStarted: 'integration.sync.mapping.started',
    syncMappingFinished: 'integration.sync.mapping.finished',
    syncMappingFailed: 'integration.sync.mapping.failed',
    assetCreated: 'integration.asset.created',
    assetUpdated: 'integration.asset.updated',
    assetClaimed: 'integration.asset.claimed',
    assetArchived: 'integration.asset.archived',
    assetReleased: 'integration.asset.released',
    matchAmbiguous: 'integration.match.ambiguous',
  },
  subnet: {
    create: 'subnet.create',
    update: 'subnet.update',
    archive: 'subnet.archive',
    restore: 'subnet.restore',
    reservationCreate: 'subnet.reservation.create',
    reservationUpdate: 'subnet.reservation.update',
    reservationDelete: 'subnet.reservation.delete',
  },
  // Security Center actions. `session.revoke` is written when an
  // admin holding `user.manage` ends another user's session via
  // `DELETE /security/sessions/:id`. The targeted session id lands in
  // `entityId`; `after.targetUserId` carries the affected user so the
  // audit-log UI surfaces the right name without a join.
  security: {
    sessionRevoke: 'security.session.revoke',
    ipRuleCreate: 'security.ip_rule.create',
    ipRuleUpdate: 'security.ip_rule.update',
    ipRuleDelete: 'security.ip_rule.delete',
    // Phase 6 — every rejection from `safeFetch` is recorded so an
    // operator can see exactly which integration / driver / job tried
    // to talk to a private address. `entityType: 'Egress'`, `entityId`
    // null; `after` carries `{ url, hostname, resolvedIps, reason,
    // matchedCidr }`.
    egressBlocked: 'security.egress.blocked',
  },
} as const;

export const ALL_AUDIT_ACTIONS: string[] = [
  ...Object.values(AUDIT_ACTIONS.auth),
  ...Object.values(AUDIT_ACTIONS.user),
  ...Object.values(AUDIT_ACTIONS.company),
  ...Object.values(AUDIT_ACTIONS.membership),
  ...Object.values(AUDIT_ACTIONS.settings),
  ...Object.values(AUDIT_ACTIONS.domain),
  ...Object.values(AUDIT_ACTIONS.password),
  ...Object.values(AUDIT_ACTIONS.export),
  ...Object.values(AUDIT_ACTIONS.alert),
  ...Object.values(AUDIT_ACTIONS.asset),
  ...Object.values(AUDIT_ACTIONS.article),
  ...Object.values(AUDIT_ACTIONS.integration),
  ...Object.values(AUDIT_ACTIONS.subnet),
  ...Object.values(AUDIT_ACTIONS.security),
];
