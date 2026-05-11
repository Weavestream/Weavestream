import { Injectable, Logger } from '@nestjs/common';
import {
  AlertsJobNames,
  QueueNames,
  type AlertsSendJob,
  type AlertExpirationKind,
  type AlertType,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueuesService } from '../queues/queues.service.js';

/**
 * Pure evaluators for the three time/state-based alert types.
 * Invoked by `apps/worker/src/alerts/alerts.processor.ts` on every
 * `alerts:scan` cron tick.
 *
 *   - SINGLE_EXPIRATION  — one email per matching item, deduped by
 *                          `single:<kind>:<itemId>` so the same TLS
 *                          cert isn't repeatedly emailed about. Honours
 *                          `stopAfterTrigger` (default true) — when
 *                          false, every scan within the window
 *                          re-fires (use sparingly).
 *   - EXPIRATION_LIST    — one digest email per config per day,
 *                          deduped by `list:<YYYY-MM-DD>` so the
 *                          scan-frequency knob doesn't matter.
 *   - WEBSITE_DOWN       — fires once per `httpDownSince` transition,
 *                          deduped by `web-down:<domainId>:<isoDate>`
 *                          so a flapping site doesn't spam.
 *
 * The runner does NOT send the email itself — every match is emitted
 * as an `alerts:send` BullMQ job. That keeps SMTP I/O out of the scan
 * (which holds a single lock window per minute) and lets the email
 * worker retry independently on transient failures.
 */
@Injectable()
export class AlertsRunnerService {
  private readonly logger = new Logger(AlertsRunnerService.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  async runOnce(): Promise<{ enqueued: number }> {
    const configs = await this.prisma.alertConfig.findMany({
      where: {
        archivedAt: null,
        enabled: true,
        type: { in: ['SINGLE_EXPIRATION', 'EXPIRATION_LIST', 'WEBSITE_DOWN'] },
      },
    });
    if (configs.length === 0) return { enqueued: 0 };

    let enqueued = 0;
    for (const config of configs) {
      try {
        const n = await this.evaluate(config);
        enqueued += n;
      } catch (err) {
        this.logger.warn(
          `evaluator failed for config ${config.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { enqueued };
  }

  private async evaluate(config: AlertConfigRow): Promise<number> {
    switch (config.type as AlertType) {
      case 'SINGLE_EXPIRATION':
        return this.evalSingleExpiration(config);
      case 'EXPIRATION_LIST':
        return this.evalExpirationList(config);
      case 'WEBSITE_DOWN':
        return this.evalWebsiteDown(config);
      default:
        return 0;
    }
  }

  // ------------------------------------------------------------------
  // SINGLE_EXPIRATION
  // ------------------------------------------------------------------

  private async evalSingleExpiration(config: AlertConfigRow): Promise<number> {
    const items = await this.collectExpirations(config);
    let enqueued = 0;
    for (const item of items) {
      const triggerKey = config.stopAfterTrigger
        ? `single:${item.kind}:${item.id}`
        : `single:${item.kind}:${item.id}:${todayUtc()}`;
      const wasNew = await this.upsertTrigger(config.id, triggerKey);
      if (!wasNew) continue;

      await this.enqueueSend(config, {
        triggerKey,
        subject: singleSubject(item),
        text: renderSingleExpirationText(config.name, item),
      });
      enqueued += 1;
    }
    return enqueued;
  }

  // ------------------------------------------------------------------
  // EXPIRATION_LIST
  // ------------------------------------------------------------------

  private async evalExpirationList(config: AlertConfigRow): Promise<number> {
    const items = await this.collectExpirations(config);
    if (items.length === 0) return 0;

    // One digest per UTC day. The dedup key is intentionally date-only
    // so the scan frequency (every 5 min default) doesn't translate
    // into 288 emails / day — only the first scan of the day sends.
    const triggerKey = `list:${config.id}:${todayUtc()}`;
    const wasNew = await this.upsertTrigger(config.id, triggerKey);
    if (!wasNew) return 0;

    await this.enqueueSend(config, {
      triggerKey,
      subject: `[Weavestream] ${items.length} expiration(s) within ${config.triggerDays ?? 0} day(s)`,
      text: renderExpirationListText(config.name, items, config.triggerDays ?? 0),
    });
    return 1;
  }

  // ------------------------------------------------------------------
  // WEBSITE_DOWN
  // ------------------------------------------------------------------

  private async evalWebsiteDown(config: AlertConfigRow): Promise<number> {
    const where = {
      archivedAt: null,
      httpDownSince: { not: null },
      ...(config.companyId ? { companyId: config.companyId } : {}),
    } as const;

    const downs = await this.prisma.monitoredDomain.findMany({
      where,
      select: {
        id: true,
        hostname: true,
        companyId: true,
        latestHttpStatus: true,
        httpDownSince: true,
      },
    });
    let enqueued = 0;
    for (const d of downs) {
      const since = d.httpDownSince!.toISOString();
      // Including `since` in the key means a recovery + re-down
      // (different `httpDownSince` timestamp) re-fires, while a
      // continuous outage stays deduped.
      const triggerKey = `web-down:${d.id}:${since}`;
      const wasNew = await this.upsertTrigger(config.id, triggerKey);
      if (!wasNew) continue;

      await this.enqueueSend(config, {
        triggerKey,
        subject: `[Weavestream] Website appears down — ${d.hostname}`,
        text: [
          `Hostname:     ${d.hostname}`,
          `HTTP status:  ${d.latestHttpStatus ?? 'unreachable'}`,
          `Down since:   ${since}`,
          '',
          'Manage your alert configurations in the Weavestream admin under Alerts.',
        ].join('\n'),
      });
      enqueued += 1;
    }
    return enqueued;
  }

  // ------------------------------------------------------------------
  // Expiration data sources
  // ------------------------------------------------------------------

  /**
   * Aggregate every expiration row that falls inside the config's
   * `triggerDays` window. Reads three surfaces:
   *   - `MonitoredDomain.whoisExpiresAt` (registrar) and `tlsExpiresAt`
   *   - `Password.expiresAt`
   *   - DATE / DATETIME `AssetField` values flagged `isExpiry`
   *
   * Expired rows are always included so a missed scan still surfaces
   * the issue. The `expirationKinds` filter narrows the set; `'all'`
   * is expanded to every concrete kind.
   */
  private async collectExpirations(
    config: AlertConfigRow,
  ): Promise<ExpirationItem[]> {
    const triggerDays = config.triggerDays ?? 30;
    const kinds = expandKinds(config.expirationKinds as AlertExpirationKind[]);
    const now = Date.now();
    const dayMs = AlertsRunnerService.DAY_MS;

    const items: ExpirationItem[] = [];

    if (kinds.has('domain_registrar') || kinds.has('domain_tls')) {
      const domains = await this.prisma.monitoredDomain.findMany({
        where: {
          archivedAt: null,
          ...(config.companyId ? { companyId: config.companyId } : {}),
        },
        select: {
          id: true,
          companyId: true,
          hostname: true,
          whoisExpiresAt: true,
          tlsExpiresAt: true,
        },
      });
      for (const d of domains) {
        if (kinds.has('domain_registrar') && d.whoisExpiresAt) {
          const daysUntil = Math.floor(
            (d.whoisExpiresAt.getTime() - now) / dayMs,
          );
          if (daysUntil <= triggerDays) {
            items.push({
              id: `${d.id}:registrar`,
              kind: 'domain_registrar',
              label: `${d.hostname} (registrar)`,
              expiresAt: d.whoisExpiresAt.toISOString(),
              daysUntil,
              companyId: d.companyId,
            });
          }
        }
        if (kinds.has('domain_tls') && d.tlsExpiresAt) {
          const daysUntil = Math.floor(
            (d.tlsExpiresAt.getTime() - now) / dayMs,
          );
          if (daysUntil <= triggerDays) {
            items.push({
              id: `${d.id}:tls`,
              kind: 'domain_tls',
              label: `${d.hostname} (TLS cert)`,
              expiresAt: d.tlsExpiresAt.toISOString(),
              daysUntil,
              companyId: d.companyId,
            });
          }
        }
      }
    }

    if (kinds.has('password')) {
      // Both hard expiry and rotation-due reminders are surfaced under
      // the single `password` kind (per the merged-kind decision). The
      // rotation cutoff depends on each row's own `rotationReminderDays`
      // so we can't pre-filter that arm in SQL — load every candidate
      // that *might* match and reject in-process below.
      const cutoff = new Date(now + triggerDays * dayMs);
      const passwords = await this.prisma.password.findMany({
        where: {
          archivedAt: null,
          ...(config.companyId ? { companyId: config.companyId } : {}),
          OR: [
            { expiresAt: { not: null, lte: cutoff } },
            {
              rotationReminderDays: { not: null },
              lastRotatedAt: { not: null },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          companyId: true,
          expiresAt: true,
          lastRotatedAt: true,
          rotationReminderDays: true,
        },
      });
      for (const p of passwords) {
        // Hard expiry row.
        if (p.expiresAt) {
          const daysUntil = Math.floor((p.expiresAt.getTime() - now) / dayMs);
          if (daysUntil <= triggerDays) {
            items.push({
              id: `${p.id}:expiry`,
              kind: 'password',
              source: 'expiry',
              label: `Password "${p.name}" (expires)`,
              expiresAt: p.expiresAt.toISOString(),
              daysUntil,
              companyId: p.companyId,
            });
          }
        }
        // Rotation-due row — credential should have been rotated by
        // `lastRotatedAt + rotationReminderDays`. Negative `daysUntil`
        // means overdue.
        if (p.rotationReminderDays != null && p.lastRotatedAt) {
          const dueAt = new Date(
            p.lastRotatedAt.getTime() + p.rotationReminderDays * dayMs,
          );
          const daysUntil = Math.floor((dueAt.getTime() - now) / dayMs);
          if (daysUntil <= triggerDays) {
            items.push({
              id: `${p.id}:rotation`,
              kind: 'password',
              source: 'rotation',
              label: `Password "${p.name}" (rotation due)`,
              expiresAt: dueAt.toISOString(),
              daysUntil,
              companyId: p.companyId,
            });
          }
        }
      }
    }

    if (kinds.has('asset')) {
      // Mirrors `ExpirationsService.listAssetFieldExpirations` —
      // candidate fields then values, post-filter against the
      // config's window so the per-field `warnWithinDays` override
      // doesn't accidentally shadow a stricter alert.
      const fields = await this.prisma.assetField.findMany({
        where: {
          archivedAt: null,
          fieldType: { in: ['DATE', 'DATETIME'] },
          options: { path: ['isExpiry'], equals: true },
        },
        select: { id: true, name: true },
      });
      if (fields.length > 0) {
        const fieldById = new Map(fields.map((f) => [f.id, f.name] as const));
        const values = await this.prisma.assetFieldValue.findMany({
          where: {
            assetFieldId: { in: fields.map((f) => f.id) },
            ...(config.companyId ? { companyId: config.companyId } : {}),
            asset: { archivedAt: null },
          },
          include: {
            asset: { select: { id: true, name: true, companyId: true } },
          },
        });
        for (const v of values) {
          const raw = v.value;
          if (typeof raw !== 'string' || raw.length === 0) continue;
          const dt = new Date(raw);
          if (Number.isNaN(dt.getTime())) continue;
          const daysUntil = Math.floor((dt.getTime() - now) / dayMs);
          if (daysUntil > triggerDays) continue;
          const fieldLabel = fieldById.get(v.assetFieldId) ?? 'expiry';
          items.push({
            id: `${v.asset.id}:${v.assetFieldId}`,
            kind: 'asset',
            label: `${v.asset.name} — ${fieldLabel}`,
            expiresAt: dt.toISOString(),
            daysUntil,
            companyId: v.asset.companyId,
          });
        }
      }
    }

    items.sort((a, b) => a.daysUntil - b.daysUntil);
    return items;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Atomically write the dedup row. Returns `true` if the row was
   * inserted (caller should fire), `false` if it already existed
   * (already fired — skip).
   */
  private async upsertTrigger(
    alertConfigId: string,
    key: string,
  ): Promise<boolean> {
    const result = await this.prisma.alertTrigger.createMany({
      data: [{ alertConfigId, key }],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  private async enqueueSend(
    config: AlertConfigRow,
    parts: { triggerKey: string; subject: string; text: string },
  ): Promise<void> {
    const payload: AlertsSendJob = {
      kind: 'send',
      alertConfigId: config.id,
      triggerKey: parts.triggerKey,
      recipientEmails: config.recipientEmails,
      subject: parts.subject,
      text: parts.text,
    };
    const queue = this.queues.get(QueueNames.alerts);
    await queue.add(AlertsJobNames.send, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  }
}

// `AlertConfigRow` is the full Prisma row shape. Imported lazily as a
// `type` only so this file (which is also reachable from worker code)
// stays free of side-effecting imports.
type AlertConfigRow =
  import('@prisma/client').AlertConfig;

interface ExpirationItem {
  id: string;
  kind: AlertExpirationKind;
  /**
   * Sub-source within a kind. Currently only used by `password` to
   * distinguish a hard `expiresAt` row from a rotation-due reminder
   * derived from `lastRotatedAt + rotationReminderDays`.
   */
  source?: 'expiry' | 'rotation';
  label: string;
  expiresAt: string;
  daysUntil: number;
  companyId: string;
}

function expandKinds(raw: AlertExpirationKind[]): Set<AlertExpirationKind> {
  if (raw.includes('all')) {
    return new Set<AlertExpirationKind>([
      'asset',
      'domain_registrar',
      'domain_tls',
      'password',
    ]);
  }
  return new Set(raw);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function singleSubject(item: ExpirationItem): string {
  // Rotation reminders read awkwardly as "Expiring in N day(s)" — the
  // credential isn't expiring, it just needs to be cycled. Branch the
  // subject so the inbox preview matches what the operator should do.
  if (item.kind === 'password' && item.source === 'rotation') {
    if (item.daysUntil < 0) {
      return `[Weavestream] Rotation overdue by ${Math.abs(item.daysUntil)} day(s) — ${item.label}`;
    }
    return `[Weavestream] Rotation due in ${item.daysUntil} day(s) — ${item.label}`;
  }
  if (item.daysUntil < 0) {
    return `[Weavestream] Expired ${Math.abs(item.daysUntil)} day(s) ago — ${item.label}`;
  }
  return `[Weavestream] Expiring in ${item.daysUntil} day(s) — ${item.label}`;
}

function renderSingleExpirationText(
  configName: string,
  item: ExpirationItem,
): string {
  const isRotation = item.kind === 'password' && item.source === 'rotation';
  const status = isRotation
    ? item.daysUntil < 0
      ? 'rotation overdue'
      : 'rotation due'
    : item.daysUntil < 0
      ? 'expired'
      : 'expiring';
  return [
    `Alert: ${configName}`,
    `Item:  ${item.label}`,
    `Status: ${status} (${item.daysUntil} day(s))`,
    `When:  ${item.expiresAt}`,
    '',
    'Manage your alert configurations in the Weavestream admin under Alerts.',
  ].join('\n');
}

function renderExpirationListText(
  configName: string,
  items: ExpirationItem[],
  triggerDays: number,
): string {
  const lines: string[] = [
    `Alert: ${configName}`,
    `${items.length} expiration(s) within ${triggerDays} day(s):`,
    '',
  ];
  for (const item of items) {
    const status = item.daysUntil < 0 ? 'EXPIRED' : `${item.daysUntil}d`;
    lines.push(`  • [${status.padStart(7)}] ${item.label} — ${item.expiresAt}`);
  }
  lines.push(
    '',
    'Manage your alert configurations in the Weavestream admin under Alerts.',
  );
  return lines.join('\n');
}
