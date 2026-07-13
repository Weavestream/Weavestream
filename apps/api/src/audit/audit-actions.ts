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
    refreshTokenReused: 'auth.refresh.reused',
    mfaEnroll: 'auth.mfa.enroll',
    mfaEnrollComplete: 'auth.mfa.enroll.complete',
    mfaVerifySuccess: 'auth.mfa.verify.success',
    mfaVerifyFailure: 'auth.mfa.verify.failure',
    mfaBackupUsed: 'auth.mfa.backup.used',
    mfaBackupRegenerate: 'auth.mfa.backup.regenerate',
    sessionsRevokeOthers: 'auth.sessions.revoke_others',
  },
  user: {
    create: 'user.create',
    update: 'user.update',
    roleChange: 'user.role.change',
    deactivate: 'user.deactivate',
    passwordChange: 'user.password.change',
    passwordChangeFailed: 'user.password.change.failed',
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
    aiUpdate: 'settings.ai.update',
    aiTest: 'settings.ai.test',
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
  // is written to storage and includes the byte size + whether
  // plaintext passwords were embedded. Both rows carry the same
  // `exportId` in `entityId` so the audit log groups them together.
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
    purge: 'article.purge',
    // Version control. `versionRestored` mirrors the password vault
    // pattern: vN's body is re-applied via the normal update path,
    // which records a fresh published version + an extra
    // `restoredFromVersion` field in `after`. `draftDiscard` fires
    // when an operator clicks Cancel after autosave had created a
    // draft — `after.discardedVersion` carries the version number
    // the autosave was holding.
    versionRestored: 'article.version.restored',
    draftDiscard: 'article.draft.discard',
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
    resourceCreate: 'integration.resource.create',
    resourceUpdate: 'integration.resource.update',
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
    // Cloudflare Rules Lists integration. `entityType: 'CloudflareIpList'`
    // for list-level rows; entry-level mutations carry the same entityId
    // (the list row) with the diff in `after`.
    cloudflareListRegister: 'integration.cloudflare.list.register',
    cloudflareListUnregister: 'integration.cloudflare.list.unregister',
    cloudflareEntryAdd: 'integration.cloudflare.entry.add',
    cloudflareEntryUpdate: 'integration.cloudflare.entry.update',
    cloudflareEntryRemove: 'integration.cloudflare.entry.remove',
    cloudflareOverwrite: 'integration.cloudflare.overwrite',
    cloudflareDriftCheck: 'integration.cloudflare.drift_check',
    cloudflareDriftSelfHealed: 'integration.cloudflare.drift_self_healed',
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
  // Scheduled Postgres export feature. Config CRUD rows carry the
  // `BackupConfig.id` in `entityId`; per-run rows carry the
  // `BackupRun.id` so History entries line up with the backup row.
  backup: {
    configCreate: 'backup.config.create',
    configUpdate: 'backup.config.update',
    configDelete: 'backup.config.delete',
    runTriggered: 'backup.run.triggered',
    runCompleted: 'backup.run.completed',
    runFailed: 'backup.run.failed',
    runDownloaded: 'backup.run.downloaded',
  },
  security: {
    sessionRevoke: 'security.session.revoke',
    ipRuleCreate: 'security.ip_rule.create',
    ipRuleUpdate: 'security.ip_rule.update',
    ipRuleDelete: 'security.ip_rule.delete',
    // Step-up (re-authentication) on highly sensitive admin actions.
    // `verified` / `failed` carry `{ factor, method?, sessionId }` in
    // `after` — never the submitted credential. `anomaly` flags an
    // inconsistent MFA state (mfaEnabled with no stored secret) that
    // forced a password fallback; it should never fire in practice.
    stepUpVerified: 'security.stepup.verified',
    stepUpFailed: 'security.stepup.failed',
    stepUpAnomaly: 'security.stepup.anomaly',
    // Phase 6 — every rejection from `safeFetch` is recorded so an
    // operator can see exactly which integration / driver / job tried
    // to talk to a private address. `entityType: 'Egress'`, `entityId`
    // null; `after` carries `{ url, hostname, resolvedIps, reason,
    // matchedCidr }`.
    egressBlocked: 'security.egress.blocked',
  },
  // Upload lifecycle. `create`/`delete`/`restore` are per-row operator
  // actions on a single Upload row; `path_revealed` records a SUPER_ADMIN
  // disclosing an upload's internal storage key (a sensitive read, akin to
  // `password.revealed`). `reap` is the Phase 7 soft-deleted reaper sweep —
  // one roll-up row per tick (not per row) with totals in `after`,
  // `actorId` null (the worker fires it) and `entityId` null (the row
  // aggregates many uploads).
  upload: {
    create: 'upload.create',
    delete: 'upload.delete',
    restore: 'upload.restore',
    revealPath: 'upload.path_revealed',
    reap: 'upload.reap',
  },
  // WS-030 — AI chat read tools. One row per executor invocation,
  // regardless of exit path: `entityType: 'AiTool'`, `entityId` = the
  // tool-call id from the streaming turn, `companyId` = the resolved
  // scope (null when resolution failed). `after` carries ONLY
  // `{ outcome, correlationId, argsSha256 }` — outcome ∈ ok |
  // invalid_args | budget_exhausted | not_found | denied | error, and
  // argsSha256 is a SHA-256 of the canonical-JSON VALIDATED arguments
  // (null for invalid_args, where nothing passed validation). Raw
  // arguments, document content and tool results are never stored —
  // same rule as `tickets.*`: identifiers, not content.
  aiTool: {
    search: 'ai_tool.search',
    findRelatedItems: 'ai_tool.find_related_items',
    getArticle: 'ai_tool.get_article',
    getRelatedItems: 'ai_tool.get_related_items',
    getCompanySummary: 'ai_tool.get_company_summary',
    getAppHelp: 'ai_tool.get_app_help',
  },
  // Phase 12 — real-time external ticket browse (NinjaOne first).
  // Tickets are NEVER persisted, so the audit log is the only record
  // that a given operator looked at a given ticket id. `entityType`
  // is 'Ticket'; `entityId` is the provider ticket id (opaque string,
  // never a Weavestream uuid). `companyId` is always set. We log the
  // identifiers only — never the ticket subject/body — so audit
  // entries don't leak customer-supplied content into a second store.
  tickets: {
    list: 'tickets.list',
    view: 'tickets.view',
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
  ...Object.values(AUDIT_ACTIONS.backup),
  ...Object.values(AUDIT_ACTIONS.upload),
  ...Object.values(AUDIT_ACTIONS.aiTool),
  ...Object.values(AUDIT_ACTIONS.tickets),
];
