import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  AlertsJobNames,
  QueueNames,
  SECURITY_ALERT_LABELS,
  isSecurityAlertSelector,
  type AlertsSendJob,
  type AlertRecordEntityType,
  type AlertRecordAction,
  type SecurityAlertSelector,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AuditLogService,
  type PersistedAuditEntry,
} from '../audit/audit.service.js';
import { EnvService } from '../config/env.service.js';
import { QueuesService } from '../queues/queues.service.js';

/**
 * Real-time alert dispatcher for `RECORD_EVENT` and `PASSWORD_EVENT`
 * configurations.
 *
 * Why this is a singleton with an in-memory cache rather than a per-
 * audit-row DB query: every CRUD on the platform funnels through
 * `AuditLogService.log()`. Issuing a `findMany` against `alert_config`
 * on the request thread for every audit write would bolt a tail of
 * Postgres latency onto every save. Instead we load enabled configs
 * once on bootstrap, refresh them in the background, and let
 * `AlertsService` invalidate the cache whenever an admin saves a
 * config — so the request path pays an O(N) JS filter against a
 * realistically <50-row list and never a query.
 *
 * Every match is dispatched as an `alerts:send` BullMQ job; the
 * worker performs the actual SMTP send and writes the `AlertTrigger`
 * dedup row. We also pre-write a "pending" `AlertTrigger` here so
 * even if the worker is offline the next scheduled scan won't
 * re-fire the same audit row.
 */
@Injectable()
export class AlertEmitterService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AlertEmitterService.name);
  /** Cache TTL for a periodic safety-net refresh (manual `invalidate` is the primary path). */
  private static readonly REFRESH_INTERVAL_MS = 60_000;
  private cache: CachedConfig[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly queues: QueuesService,
    private readonly env: EnvService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
    this.audit.registerHook((entry) => this.maybeFire(entry));
    // Safety net — if `AlertsService.invalidate()` is ever forgotten,
    // a stale cache resolves on its own within a minute.
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) =>
        this.logger.warn(
          `cache refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, AlertEmitterService.REFRESH_INTERVAL_MS);
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Force-reload the cache. Called by `AlertsService` after every
   * create / update / archive so a freshly saved config takes effect
   * on the next CRUD without waiting for the periodic refresh.
   */
  async invalidate(): Promise<void> {
    await this.refresh();
  }

  /**
   * Inspect a freshly persisted audit entry and dispatch matching
   * configs. Failures are swallowed and logged — the user write that
   * triggered this hook must never fail because alerts misbehaved.
   */
  async maybeFire(entry: PersistedAuditEntry): Promise<void> {
    if (this.cache.length === 0) return;

    // Security actions take a fully separate path. The two matchers are
    // disjoint by construction — no security action parses as a CRUD
    // action (parseAuditAction drops auth.*/security.*/user.*), and no
    // CRUD action appears in SECURITY_ACTION_MAP — so an existing
    // `recordEntityTypes: ['all']` config can never auto-subscribe to
    // security events, and a security config never fires on CRUD.
    const securityRule = SECURITY_ACTION_MAP[entry.action];
    if (securityRule) {
      await this.maybeFireSecurity(entry, securityRule);
      return;
    }

    const parsed = parseAuditAction(entry.action);
    if (!parsed) return;

    const matches = this.cache.filter(
      (c) =>
        // Belt-and-suspenders: keep reserved-selector configs out of the
        // CRUD path even though their selector could never equal a
        // parsed entity anyway.
        !c.recordEntityTypes.some(isSecurityAlertSelector) &&
        configMatches(c, parsed, entry.companyId),
    );
    if (matches.length === 0) return;

    for (const config of matches) {
      try {
        await this.dispatch(config, entry, parsed);
      } catch (err) {
        this.logger.warn(
          `alert dispatch failed for config ${config.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Security-event path. `rule.kinds` names which reserved-selector
   * configs an action can fire; `shouldFireSecurity` applies the
   * per-action firing semantics (immediate vs threshold-reach).
   */
  private async maybeFireSecurity(
    entry: PersistedAuditEntry,
    rule: SecurityActionRule,
  ): Promise<void> {
    if (!this.shouldFireSecurity(entry, rule)) return;

    const matches = this.cache.filter((c) => {
      const selector = securitySelectorOf(c);
      return selector !== null && rule.kinds.includes(selector);
    });
    if (matches.length === 0) return;

    const actor = await this.lookupActor(entry.actorId);
    for (const config of matches) {
      try {
        await this.dispatchSecurity(config, entry, actor);
      } catch (err) {
        this.logger.warn(
          `security alert dispatch failed for config ${config.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Firing semantics per action:
   *
   *  - `immediate` — every (already emission-coalesced or upstream-
   *    guarded) event fires.
   *  - `login-threshold` — fires exactly when either login counter
   *    REACHES `LOCKOUT_MAX_FAILURES`. Strict equality is deliberate:
   *    once locked, the 429 precedes `recordFailure`, so a counter
   *    passes the threshold value at most once per window — and under
   *    the isLocked race two concurrent failures get DISTINCT counts
   *    (5, 6, …), so exactly one row carries the threshold. `>=` would
   *    fire twice in that race.
   *  - `count-threshold` — same, for the single per-user counters
   *    (MFA / step-up / change-password).
   *
   * Absent or null counts (Redis degraded) simply never fire — a
   * missed notification is the accepted failure mode; the event
   * itself is durable in the audit log either way.
   */
  private shouldFireSecurity(
    entry: PersistedAuditEntry,
    rule: SecurityActionRule,
  ): boolean {
    const threshold = this.env.values.LOCKOUT_MAX_FAILURES;
    switch (rule.mode) {
      case 'immediate':
        return true;
      case 'login-threshold': {
        const counts = loginFailureCounts(entry.after);
        return counts.ip === threshold || counts.email === threshold;
      }
      case 'count-threshold':
        return readNumberField(entry.after, 'failureCount') === threshold;
    }
  }

  private async dispatchSecurity(
    config: CachedConfig,
    entry: PersistedAuditEntry,
    actor: { name: string; email: string } | null,
  ): Promise<void> {
    // One email per audit event per config — except the step-up anomaly,
    // a persistent-misconfiguration signal that would otherwise email on
    // every retry of the same broken state: day-bucket it per user.
    const triggerKey =
      entry.action === 'security.stepup.anomaly' && entry.actorId
        ? `sec:anomaly:${entry.actorId}:${entry.createdAt.toISOString().slice(0, 10)}`
        : `audit:${entry.id}:${config.id}`;

    const selector = securitySelectorOf(config);
    const kindLabel = selector ? SECURITY_ALERT_LABELS[selector] : 'Security';
    await this.createTriggerAndEnqueue(config, triggerKey, async () => ({
      subject: `[Weavestream] Security — ${kindLabel} — ${config.name}`,
      text: renderSecurityText(
        config,
        entry,
        actor,
        this.env.values.LOCKOUT_WINDOW_MIN,
      ),
    }));
  }

  private async dispatch(
    config: CachedConfig,
    entry: PersistedAuditEntry,
    parsed: ParsedAction,
  ): Promise<void> {
    const triggerKey = `audit:${entry.id}:${config.id}`;
    await this.createTriggerAndEnqueue(config, triggerKey, async () => {
      // Resolve UUIDs to human labels so the email body shows e.g.
      // "Asset: Acme Laptop" instead of the bare entity UUID. Lookups
      // are best-effort: a hard-deleted row falls back to the audit
      // payload's snapshot, then the UUID itself.
      const resolved = await this.resolveLabels(entry, parsed);
      return {
        subject: renderRealtimeSubject(config, entry, parsed, resolved),
        text: renderRealtimeText(config, entry, parsed, resolved),
      };
    });
  }

  /**
   * Shared dispatch tail for the CRUD and security paths: pre-write the
   * dedup row inside a `skipDuplicates` upsert so a retry (or a second
   * qualifying event mapping to the same key) can't double-send, then
   * render and enqueue. Rendering happens via callback AFTER the claim
   * so a duplicate costs one INSERT-noop and no lookup work — same
   * order the pre-refactor code had.
   */
  private async createTriggerAndEnqueue(
    config: CachedConfig,
    triggerKey: string,
    render: () => Promise<{ subject: string; text: string }>,
  ): Promise<void> {
    const created = await this.prisma.alertTrigger.createMany({
      data: [{ alertConfigId: config.id, key: triggerKey }],
      skipDuplicates: true,
    });
    if (created.count === 0) return;

    const { subject, text } = await render();
    const payload: AlertsSendJob = {
      kind: 'send',
      alertConfigId: config.id,
      triggerKey,
      recipientEmails: config.recipientEmails,
      subject,
      text,
    };
    const queue = this.queues.get(QueueNames.alerts);
    await queue.add(AlertsJobNames.send, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  }

  /**
   * Resolve the audit row's UUID references (`entityId`, `companyId`,
   * `actorId`) to human-readable labels for the email body. Each
   * lookup is best-effort: if the row was hard-deleted we fall back
   * to a name field carried in the audit payload's `before`/`after`
   * snapshot, and ultimately to the bare UUID so the recipient still
   * has something traceable.
   *
   * Runs as a single `Promise.all` against three small indexed lookups
   * (PK / unique index hits) so the added latency on the audit hook
   * path is negligible.
   */
  private async resolveLabels(
    entry: PersistedAuditEntry,
    parsed: ParsedAction,
  ): Promise<ResolvedLabels> {
    const [entityName, companyName, actor] = await Promise.all([
      this.lookupEntityName(parsed.entity, entry.entityId),
      this.lookupCompanyName(entry.companyId),
      this.lookupActor(entry.actorId),
    ]);
    return {
      entityName: entityName ?? extractSnapshotName(parsed.entity, entry),
      companyName,
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
    };
  }

  private async lookupEntityName(
    entity: AlertRecordEntityType,
    entityId: string | null,
  ): Promise<string | null> {
    if (!entityId) return null;
    try {
      switch (entity) {
        case 'asset': {
          const row = await this.prisma.asset.findUnique({
            where: { id: entityId },
            select: { name: true },
          });
          return row?.name ?? null;
        }
        case 'article': {
          const row = await this.prisma.article.findUnique({
            where: { id: entityId },
            select: { title: true },
          });
          return row?.title ?? null;
        }
        case 'password': {
          const row = await this.prisma.password.findUnique({
            where: { id: entityId },
            select: { name: true },
          });
          return row?.name ?? null;
        }
        case 'domain': {
          const row = await this.prisma.monitoredDomain.findUnique({
            where: { id: entityId },
            select: { hostname: true },
          });
          return row?.hostname ?? null;
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private async lookupCompanyName(
    companyId: string | null,
  ): Promise<string | null> {
    if (!companyId) return null;
    try {
      const row = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      });
      return row?.name ?? null;
    } catch {
      return null;
    }
  }

  private async lookupActor(
    actorId: string | null,
  ): Promise<{ name: string; email: string } | null> {
    if (!actorId) return null;
    try {
      const row = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { name: true, email: true },
      });
      return row ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Cache plumbing
  // ------------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const rows = await this.prisma.alertConfig.findMany({
          where: {
            archivedAt: null,
            enabled: true,
            type: { in: ['RECORD_EVENT', 'PASSWORD_EVENT'] },
          },
          select: {
            id: true,
            name: true,
            type: true,
            companyId: true,
            recipientEmails: true,
            recordEntityTypes: true,
            recordActions: true,
          },
        });
        this.cache = rows.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type as 'RECORD_EVENT' | 'PASSWORD_EVENT',
          companyId: row.companyId,
          recipientEmails: row.recipientEmails,
          recordEntityTypes: normaliseEntityTypes(
            row.type as 'RECORD_EVENT' | 'PASSWORD_EVENT',
            row.recordEntityTypes,
          ),
          recordActions: row.recordActions as AlertRecordAction[],
        }));
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

interface CachedConfig {
  id: string;
  name: string;
  type: 'RECORD_EVENT' | 'PASSWORD_EVENT';
  companyId: string | null;
  recipientEmails: string[];
  recordEntityTypes: AlertRecordEntityType[];
  recordActions: AlertRecordAction[];
}

interface ParsedAction {
  entity: AlertRecordEntityType;
  action: AlertRecordAction;
}

interface ResolvedLabels {
  entityName: string | null;
  companyName: string | null;
  actorName: string | null;
  actorEmail: string | null;
}

/**
 * Map a raw audit action string to the (entity, action) tuple our
 * cached configs match against. Returns `null` for actions that do
 * not represent record CRUD (auth events, settings, integrations,
 * etc.) so the hot path bails out fast.
 */
function parseAuditAction(action: string): ParsedAction | null {
  const [entityRaw, verb] = action.split('.');
  if (!entityRaw || !verb) return null;

  let entity: AlertRecordEntityType | null = null;
  switch (entityRaw) {
    case 'asset':
      entity = 'asset';
      break;
    case 'article':
      entity = 'article';
      break;
    case 'password':
      entity = 'password';
      break;
    case 'domain':
      entity = 'domain';
      break;
    default:
      return null;
  }

  // Map verbs onto our three canonical CRUD slots. Archive / restore
  // both surface as `deleted` since the platform uses soft-archive in
  // place of hard delete and admins reading "Record deleted" don't
  // care about the distinction. `password.update` stays as updated.
  let act: AlertRecordAction | null = null;
  switch (verb) {
    case 'create':
    case 'created':
      act = 'created';
      break;
    case 'update':
    case 'updated':
      act = 'updated';
      break;
    case 'archive':
    case 'archived':
    case 'delete':
    case 'deleted':
      act = 'deleted';
      break;
    default:
      return null;
  }
  return { entity, action: act };
}

function configMatches(
  config: CachedConfig,
  parsed: ParsedAction,
  auditCompanyId: string | null,
): boolean {
  if (config.companyId && config.companyId !== auditCompanyId) return false;

  if (config.type === 'PASSWORD_EVENT') {
    if (parsed.entity !== 'password') return false;
  } else {
    const entityMatch =
      config.recordEntityTypes.includes('all') ||
      config.recordEntityTypes.includes(parsed.entity);
    if (!entityMatch) return false;
  }

  const actionMatch =
    config.recordActions.includes('all') ||
    config.recordActions.includes(parsed.action);
  return actionMatch;
}

function normaliseEntityTypes(
  type: 'RECORD_EVENT' | 'PASSWORD_EVENT',
  raw: string[],
): AlertRecordEntityType[] {
  if (type === 'PASSWORD_EVENT') return ['password'];
  return raw as AlertRecordEntityType[];
}

function renderRealtimeSubject(
  config: CachedConfig,
  entry: PersistedAuditEntry,
  parsed: ParsedAction,
  resolved: ResolvedLabels,
): string {
  const verb =
    parsed.action === 'created'
      ? 'created'
      : parsed.action === 'updated'
        ? 'updated'
        : 'deleted';
  const entity =
    parsed.entity.charAt(0).toUpperCase() + parsed.entity.slice(1);
  // Prefer the resolved record + company in the subject so a recipient
  // skimming their inbox can identify both the affected item and the
  // tenant it belongs to without opening the email. Each piece is
  // dropped independently when unresolved (hard-deleted, missing id).
  const parts: string[] = [];
  if (resolved.entityName) parts.push(resolved.entityName);
  if (resolved.companyName) parts.push(`@ ${resolved.companyName}`);
  parts.push(config.name);
  return `[Weavestream] ${entity} ${verb} — ${parts.join(' — ')}`;
}

function renderRealtimeText(
  config: CachedConfig,
  entry: PersistedAuditEntry,
  parsed: ParsedAction,
  resolved: ResolvedLabels,
): string {
  const lines: string[] = [
    `Alert:   ${config.name}`,
    `Event:   ${parsed.entity} ${parsed.action}`,
    `When:    ${formatTimestamp(entry.createdAt)}`,
  ];
  if (resolved.entityName) lines.push(`Record:  ${resolved.entityName}`);
  if (resolved.companyName) lines.push(`Company: ${resolved.companyName}`);

  const actorLabel = formatActor(resolved);
  if (actorLabel) lines.push(`Actor:   ${actorLabel}`);

  lines.push(
    '',
    'You are receiving this email because an alert configuration matches this event.',
    'Manage your alert configurations in the Weavestream admin under Alerts.',
  );
  return lines.join('\n');
}

/**
 * Render a timestamp as e.g. `28 Apr 2026, 11:42 UTC` — a readable
 * fixed-locale format that's unambiguous across recipients (no
 * MM/DD vs DD/MM ambiguity) and free of the trailing `.123Z` noise
 * an ISO string carries.
 */
function formatTimestamp(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  });
  return `${formatter.format(date)} UTC`;
}

function formatActor(resolved: ResolvedLabels): string | null {
  if (resolved.actorName && resolved.actorEmail) {
    return `${resolved.actorName} <${resolved.actorEmail}>`;
  }
  return resolved.actorName ?? resolved.actorEmail ?? null;
}

/**
 * Last-resort fallback that scans the audit row's `before` / `after`
 * payload for a name-like field (`name`, `title`, `hostname`). Used
 * only when the entity row itself can't be loaded — typical for hard
 * deletes — so the recipient still sees a human label rather than the
 * UUID.
 */
function extractSnapshotName(
  entity: AlertRecordEntityType,
  entry: PersistedAuditEntry,
): string | null {
  const key =
    entity === 'article' ? 'title' : entity === 'domain' ? 'hostname' : 'name';
  return readStringField(entry.after, key) ?? readStringField(entry.before, key);
}

function readStringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ------------------------------------------------------------------
// Security alerts (reserved-selector RECORD_EVENT configs)
// ------------------------------------------------------------------

interface SecurityActionRule {
  /** Which reserved-selector kinds this action can fire. */
  kinds: readonly SecurityAlertSelector[];
  /** Firing semantics — see `shouldFireSecurity`. */
  mode: 'immediate' | 'login-threshold' | 'count-threshold';
}

/**
 * Exact audit-action strings → firing rule. Keys must match the
 * literals actually written at the emission sites (several are raw
 * strings there, not `AUDIT_ACTIONS` constants — matched verbatim).
 *
 * `auth.login.failure` fans out to TWO kinds on the same threshold-
 * crossing event: it is both "repeated failed sign-ins" and the moment
 * the soft-lock engages ("IP blocked or rate limited") — no separate
 * lockout audit event exists or is needed.
 */
const SECURITY_ACTION_MAP: Record<string, SecurityActionRule> = {
  'auth.login.failure': {
    kinds: ['security:sign-in-failures', 'security:ip-blocked'],
    mode: 'login-threshold',
  },
  'security.ip_rule.blocked': {
    kinds: ['security:ip-blocked'],
    mode: 'immediate',
  },
  'security.ratelimit.blocked': {
    kinds: ['security:ip-blocked'],
    mode: 'immediate',
  },
  'auth.refresh.reused': {
    kinds: ['security:suspicious-activity'],
    mode: 'immediate',
  },
  'security.stepup.anomaly': {
    kinds: ['security:suspicious-activity'],
    mode: 'immediate',
  },
  'auth.mfa.verify.failure': {
    kinds: ['security:suspicious-activity'],
    mode: 'count-threshold',
  },
  'security.stepup.failed': {
    kinds: ['security:suspicious-activity'],
    mode: 'count-threshold',
  },
  'user.password.change.failed': {
    kinds: ['security:suspicious-activity'],
    mode: 'count-threshold',
  },
};

/**
 * The reserved selector of a security config, or null for ordinary
 * configs. Strict shape (RECORD_EVENT + exactly one reserved element) —
 * the same invariant `alertConfigInputSchema` enforces at write time.
 */
function securitySelectorOf(config: CachedConfig): SecurityAlertSelector | null {
  if (config.type !== 'RECORD_EVENT') return null;
  if (config.recordEntityTypes.length !== 1) return null;
  const sole = config.recordEntityTypes[0];
  return isSecurityAlertSelector(sole) ? sole : null;
}

function readNumberField(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function loginFailureCounts(after: unknown): {
  ip: number | null;
  email: number | null;
} {
  if (!after || typeof after !== 'object') return { ip: null, email: null };
  const counts = (after as Record<string, unknown>).failureCounts;
  return {
    ip: readNumberField(counts, 'ip'),
    email: readNumberField(counts, 'email'),
  };
}

/** Bounded, single-line rendering of an attacker-influenced string. */
function cleanLine(value: string | null, max = 300): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Text body for a security alert email — a strict positive allowlist.
 * Only fields named here are ever rendered; the audit payload is never
 * serialized wholesale, so values like `tokenHashPrefix` (refresh
 * reuse) or `sessionId` (step-up / password-change) can't leak into
 * mail. Subjects carry no event data at all.
 */
function renderSecurityText(
  config: CachedConfig,
  entry: PersistedAuditEntry,
  actor: { name: string; email: string } | null,
  windowMinutes: number,
): string {
  const lines: string[] = [
    `Alert:   ${config.name}`,
    `Event:   ${securityEventDescription(entry.action)}`,
    `When:    ${formatTimestamp(entry.createdAt)}`,
  ];

  const ip = cleanLine(entry.ip, 64);
  if (ip) lines.push(`IP:      ${ip}`);

  const actorLabel = formatActor({
    entityName: null,
    companyName: null,
    actorName: actor?.name ?? null,
    actorEmail: actor?.email ?? null,
  });
  if (actorLabel) lines.push(`Account: ${actorLabel}`);

  lines.push(...securityDetailLines(entry, windowMinutes));

  const userAgent = cleanLine(entry.userAgent, 300);
  if (userAgent) lines.push(`Agent:   ${userAgent}`);

  lines.push(
    '',
    `Audit event id: ${entry.id}`,
    '',
    'You are receiving this email because a security alert configuration matches this event.',
    'Review the full event in the Weavestream admin under Security, and manage alert configurations under Alerts.',
  );
  return lines.join('\n');
}

function securityEventDescription(action: string): string {
  switch (action) {
    case 'auth.login.failure':
      return 'Failed sign-in attempts reached the lockout threshold';
    case 'security.ip_rule.blocked':
      return 'Request denied by IP rule';
    case 'security.ratelimit.blocked':
      return 'Requests rate limited';
    case 'auth.refresh.reused':
      return 'Refresh token reuse detected (possible session theft)';
    case 'security.stepup.anomaly':
      return 'Step-up anomaly: MFA enabled without a stored secret';
    case 'auth.mfa.verify.failure':
      return 'MFA verification failures reached the lockout threshold';
    case 'security.stepup.failed':
      return 'Step-up verification failures reached the lockout threshold';
    case 'user.password.change.failed':
      return 'Password-change verification failures reached the lockout threshold';
    default:
      return action;
  }
}

/** Per-action allowlisted detail lines from the audit `after` payload. */
function securityDetailLines(
  entry: PersistedAuditEntry,
  windowMinutes: number,
): string[] {
  const lines: string[] = [];
  const after = entry.after;

  switch (entry.action) {
    case 'auth.login.failure': {
      const attempted = cleanLine(readStringField(after, 'attemptedEmail'), 255);
      if (attempted) lines.push(`Attempted email: ${attempted}`);
      const counts = loginFailureCounts(after);
      if (counts.ip !== null) {
        lines.push(`Failures from this IP: ${counts.ip} within ${windowMinutes} min`);
      }
      if (counts.email !== null) {
        lines.push(`Failures for this email: ${counts.email} within ${windowMinutes} min`);
      }
      break;
    }
    case 'security.ip_rule.blocked': {
      const cidr = cleanLine(readStringField(after, 'cidr'), 64);
      if (cidr) lines.push(`Matched rule: ${cidr}`);
      const priority = readNumberField(after, 'priority');
      if (priority !== null) lines.push(`Rule priority: ${priority}`);
      const source = readStringField(after, 'source');
      lines.push(`Blocked at: ${source === 'web' ? 'web page layer' : 'API'}`);
      const path = cleanLine(readStringField(after, 'path'), 300);
      if (path) lines.push(`Path:    ${path}`);
      break;
    }
    case 'security.ratelimit.blocked': {
      const limiter = cleanLine(readStringField(after, 'limiter'), 32);
      if (limiter) lines.push(`Limiter: ${limiter}`);
      const limit = readNumberField(after, 'limit');
      const windowSec = readNumberField(after, 'windowSec');
      if (limit !== null && windowSec !== null) {
        lines.push(`Limit:   ${limit} requests per ${windowSec}s`);
      }
      const method = cleanLine(readStringField(after, 'method'), 12);
      const route = cleanLine(readStringField(after, 'route'), 300);
      if (route) lines.push(`Route:   ${method ? `${method} ` : ''}${route}`);
      const retry = readNumberField(after, 'retryAfterSec');
      if (retry !== null) lines.push(`Retry allowed in: ${retry}s`);
      const attempted = cleanLine(readStringField(after, 'attemptedEmail'), 255);
      if (attempted) lines.push(`Attempted email: ${attempted}`);
      break;
    }
    case 'auth.refresh.reused': {
      const reason = cleanLine(readStringField(after, 'reason'), 64);
      if (reason) lines.push(`Reason:  ${reason}`);
      break;
    }
    case 'security.stepup.anomaly': {
      const reason = cleanLine(readStringField(after, 'reason'), 64);
      if (reason) lines.push(`Reason:  ${reason}`);
      break;
    }
    case 'security.stepup.failed': {
      const factor = cleanLine(readStringField(after, 'factor'), 16);
      if (factor) lines.push(`Factor:  ${factor}`);
      const count = readNumberField(after, 'failureCount');
      if (count !== null) {
        lines.push(`Failures: ${count} within ${windowMinutes} min`);
      }
      break;
    }
    case 'auth.mfa.verify.failure':
    case 'user.password.change.failed': {
      const count = readNumberField(after, 'failureCount');
      if (count !== null) {
        lines.push(`Failures: ${count} within ${windowMinutes} min`);
      }
      break;
    }
    default:
      break;
  }
  return lines;
}
