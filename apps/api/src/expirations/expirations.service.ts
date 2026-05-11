import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Default warning window (days) used when a DATE/DATETIME field is
 * marked `isExpiry` but has no explicit `warnWithinDays` configured.
 * Chosen to match `MonitoredDomain.alertThresholdDays`' default so the
 * two surfaces line up visually.
 */
const DEFAULT_WARN_WITHIN_DAYS = 30;

/**
 * Upper bound on the number of rows returned. Keeps the unified
 * Expiring-soon table bounded even for tenants with lots of legacy
 * certs / warranties piling up. Callers paginate on the client if
 * they really need the overflow.
 */
const MAX_RESULTS = 500;

export type ExpirationStatus = 'EXPIRED' | 'WARNING';

export type AssetFieldExpiration = {
  kind: 'asset-field';
  companyId: string;
  companyName: string;
  companySlug: string;
  assetId: string;
  assetName: string;
  layoutId: string;
  layoutName: string;
  layoutIcon: string;
  layoutColor: string;
  fieldId: string;
  fieldSlug: string;
  fieldLabel: string;
  fieldType: 'DATE' | 'DATETIME';
  /** ISO 8601 (date-only for DATE, full timestamp for DATETIME). */
  expiresAt: string;
  /** Signed whole days to expiry. Negative values are already expired. */
  daysUntil: number;
  status: ExpirationStatus;
  /** Effective threshold used to keep this row (per-field override or default). */
  warnWithinDays: number;
};

export type DomainExpiration = {
  kind: 'domain';
  companyId: string;
  companyName: string;
  companySlug: string;
  domainId: string;
  hostname: string;
  source: 'registrar' | 'tls';
  expiresAt: string;
  daysUntil: number;
  status: ExpirationStatus;
};

export type PasswordExpiration = {
  kind: 'password';
  companyId: string;
  companyName: string;
  companySlug: string;
  passwordId: string;
  passwordName: string;
  /**
   * Two disjoint sources per password: `expiry` for the hard
   * `expiresAt` cutoff (the credential should stop being used after
   * this date) and `rotation` for the soft "should be rotated by now"
   * date derived from `lastRotatedAt + rotationReminderDays`. A single
   * credential can yield up to one row of each kind.
   */
  source: 'expiry' | 'rotation';
  expiresAt: string;
  daysUntil: number;
  status: ExpirationStatus;
};

export type ExpirationRow =
  | AssetFieldExpiration
  | DomainExpiration
  | PasswordExpiration;

interface ComputeOptions {
  /** When set, results are limited to a single tenant. */
  companyId?: string;
  /** Viewer's role — drives CLIENT_USER domain visibility filtering. */
  actor: AuthedUser;
}

/**
 * ExpirationsService
 *
 * Read-only aggregator that surfaces three classes of upcoming/past
 * deadlines on a single feed:
 *
 *   1. DATE/DATETIME asset fields flagged `options.isExpiry = true`
 *      (e.g. warranty end, license renewal, cert rotation). Per-field
 *      `options.warnWithinDays` overrides the default 30-day window;
 *      expired rows are always included.
 *   2. Monitored domains in EXPIRING/EXPIRED states, split by source
 *      (registrar WHOIS + TLS cert) so each upcoming renewal is its
 *      own row.
 *   3. Password credentials — hard `expiresAt` and soft rotation-due
 *      derived from `lastRotatedAt + rotationReminderDays`, each as
 *      its own row so a single credential can surface twice.
 *
 * The service is a read-side composition over PrismaService + the
 * existing domain denormalisations — it adds no new tables, no new
 * writes, and no indices beyond what's already in schema.prisma.
 */
@Injectable()
export class ExpirationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(options: ComputeOptions): Promise<ExpirationRow[]> {
    const [assetRows, domainRows, passwordRows] = await Promise.all([
      this.listAssetFieldExpirations(options),
      this.listDomainExpirations(options),
      this.listPasswordExpirations(options),
    ]);
    // Merge and order by imminence. Stable tiebreaker on company name
    // + row kind keeps the output deterministic for snapshot tests.
    const merged: ExpirationRow[] = [
      ...assetRows,
      ...domainRows,
      ...passwordRows,
    ];
    merged.sort((a, b) => {
      if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
      if (a.companyName !== b.companyName)
        return a.companyName.localeCompare(b.companyName);
      return a.kind.localeCompare(b.kind);
    });
    return merged.slice(0, MAX_RESULTS);
  }

  // ------------------------------------------------------------------
  // Asset fields
  // ------------------------------------------------------------------

  private async listAssetFieldExpirations(
    options: ComputeOptions,
  ): Promise<AssetFieldExpiration[]> {
    // Candidate fields: DATE/DATETIME, not archived, flagged as expiry
    // via a Postgres JSON path match. We can't filter by the optional
    // `warnWithinDays` here because a missing value is legal (→ default)
    // so post-filtering in-process is the simplest correct approach.
    const fields = await this.prisma.assetField.findMany({
      where: {
        archivedAt: null,
        fieldType: { in: ['DATE', 'DATETIME'] },
        options: { path: ['isExpiry'], equals: true },
      },
      select: {
        id: true,
        slug: true,
        name: true,
        fieldType: true,
        options: true,
      },
    });

    if (fields.length === 0) return [];

    // Cap the effective threshold so the JSONB scan we issue next stays
    // bounded — a malicious field config couldn't otherwise ask for a
    // 10-year window. 5 years matches the schema-level
    // `warnWithinDays.max(3650)` shared validator.
    const now = Date.now();
    const dayMs = 86_400_000;
    const byId = new Map<
      string,
      {
        slug: string;
        name: string;
        fieldType: 'DATE' | 'DATETIME';
        warnWithinDays: number;
      }
    >();
    for (const f of fields) {
      const opts = (f.options ?? {}) as { warnWithinDays?: unknown };
      const warn =
        typeof opts.warnWithinDays === 'number' &&
        Number.isFinite(opts.warnWithinDays) &&
        opts.warnWithinDays > 0
          ? Math.min(opts.warnWithinDays, 3650)
          : DEFAULT_WARN_WITHIN_DAYS;
      byId.set(f.id, {
        slug: f.slug,
        name: f.name,
        fieldType: f.fieldType as 'DATE' | 'DATETIME',
        warnWithinDays: warn,
      });
    }

    const values = await this.prisma.assetFieldValue.findMany({
      where: {
        assetFieldId: { in: Array.from(byId.keys()) },
        ...(options.companyId ? { companyId: options.companyId } : {}),
        asset: { archivedAt: null },
      },
      include: {
        asset: {
          select: {
            id: true,
            name: true,
            companyId: true,
            assetLayout: {
              select: { id: true, name: true, icon: true, color: true },
            },
          },
        },
      },
    });

    if (values.length === 0) return [];

    // `Asset.company` isn't a declared Prisma relation (companyId is a
    // denormalised uuid for tenant-scoping), so hydrate display strings
    // via a single batched query instead of N joins. Same trick the
    // cross-company domains feed uses.
    const companies = await this.prisma.company.findMany({
      where: {
        id: { in: Array.from(new Set(values.map((v) => v.asset.companyId))) },
      },
      select: { id: true, name: true, slug: true },
    });
    const companyById = new Map(companies.map((c) => [c.id, c] as const));

    const rows: AssetFieldExpiration[] = [];
    for (const v of values) {
      const meta = byId.get(v.assetFieldId);
      if (!meta) continue;
      const co = companyById.get(v.asset.companyId);
      if (!co) continue;
      const raw = v.value;
      // DATE is stored as "YYYY-MM-DD", DATETIME as an ISO timestamp.
      // Null / malformed / non-string values are silently skipped — the
      // page's purpose is to surface actionable rows, not to report
      // malformed data (that's the layout builder's job at write time).
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const expires = new Date(raw);
      if (Number.isNaN(expires.getTime())) continue;

      const daysUntil = Math.floor((expires.getTime() - now) / dayMs);
      if (daysUntil > meta.warnWithinDays) continue;

      rows.push({
        kind: 'asset-field',
        companyId: co.id,
        companyName: co.name,
        companySlug: co.slug,
        assetId: v.asset.id,
        assetName: v.asset.name,
        layoutId: v.asset.assetLayout.id,
        layoutName: v.asset.assetLayout.name,
        layoutIcon: v.asset.assetLayout.icon,
        layoutColor: v.asset.assetLayout.color,
        fieldId: v.assetFieldId,
        fieldSlug: meta.slug,
        fieldLabel: meta.name,
        fieldType: meta.fieldType,
        expiresAt: expires.toISOString(),
        daysUntil,
        status: daysUntil < 0 ? 'EXPIRED' : 'WARNING',
        warnWithinDays: meta.warnWithinDays,
      });
    }
    return rows;
  }

  // ------------------------------------------------------------------
  // Domains
  // ------------------------------------------------------------------

  private async listDomainExpirations(
    options: ComputeOptions,
  ): Promise<DomainExpiration[]> {
    const now = Date.now();
    const dayMs = 86_400_000;

    const domains = await this.prisma.monitoredDomain.findMany({
      where: {
        archivedAt: null,
        latestStatus: { in: ['EXPIRING', 'EXPIRED', 'FAIL'] },
        ...(options.companyId ? { companyId: options.companyId } : {}),
        // CLIENT_USER must never see MSP-internal domains.
        ...(options.actor.role === 'CLIENT_USER'
          ? { visibleToClients: true }
          : {}),
      },
      select: {
        id: true,
        companyId: true,
        hostname: true,
        alertThresholdDays: true,
        whoisExpiresAt: true,
        tlsExpiresAt: true,
      },
    });

    if (domains.length === 0) return [];

    // Hydrate company display strings in one batch — avoids N+1 when
    // aggregating across every tenant in the global view.
    const companies = await this.prisma.company.findMany({
      where: {
        id: { in: Array.from(new Set(domains.map((d) => d.companyId))) },
      },
      select: { id: true, name: true, slug: true },
    });
    const byCompany = new Map(companies.map((c) => [c.id, c] as const));

    const rows: DomainExpiration[] = [];
    for (const d of domains) {
      const co = byCompany.get(d.companyId);
      if (!co) continue;
      // Each domain can yield 0, 1, or 2 rows — one per expiring
      // component (registrar WHOIS + TLS cert). We only emit a row when
      // we have both an expiry date and it falls inside the configured
      // per-domain threshold (or has already passed).
      const emit = (at: Date | null, source: 'registrar' | 'tls') => {
        if (!at) return;
        const daysUntil = Math.floor((at.getTime() - now) / dayMs);
        if (daysUntil > d.alertThresholdDays) return;
        rows.push({
          kind: 'domain',
          companyId: co.id,
          companyName: co.name,
          companySlug: co.slug,
          domainId: d.id,
          hostname: d.hostname,
          source,
          expiresAt: at.toISOString(),
          daysUntil,
          status: daysUntil < 0 ? 'EXPIRED' : 'WARNING',
        });
      };
      emit(d.whoisExpiresAt, 'registrar');
      emit(d.tlsExpiresAt, 'tls');
    }
    return rows;
  }

  // ------------------------------------------------------------------
  // Passwords
  //
  // Two disjoint sources contribute rows: the hard `expiresAt` cutoff
  // (the credential should stop being used after this date) and the
  // soft "rotation due" derived from `lastRotatedAt + rotationReminderDays`.
  // One credential can yield up to two rows — same pattern as monitored
  // domains' registrar + TLS split.
  // ------------------------------------------------------------------

  private async listPasswordExpirations(
    options: ComputeOptions,
  ): Promise<PasswordExpiration[]> {
    const now = Date.now();
    const dayMs = 86_400_000;
    const cutoff = new Date(now + DEFAULT_WARN_WITHIN_DAYS * dayMs);

    const passwords = await this.prisma.password.findMany({
      where: {
        archivedAt: null,
        ...(options.companyId ? { companyId: options.companyId } : {}),
        // CLIENT_USER must never see internal-only credentials.
        ...(options.actor.role === 'CLIENT_USER'
          ? { visibleToClients: true }
          : {}),
        // Either there's a hard expiry hitting the warn window, or
        // rotation is even *eligible* (has a reminder cadence + a
        // last-rotation timestamp). The rotation-due math runs in
        // process below because the cutoff depends on the row's own
        // `rotationReminderDays`.
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
        companyId: true,
        name: true,
        expiresAt: true,
        lastRotatedAt: true,
        rotationReminderDays: true,
        restrictedToUserIds: true,
      },
    });

    if (passwords.length === 0) return [];

    // Mirror the reveal gate: a password with a non-empty allow list
    // is invisible to anyone outside the list. SUPER_ADMIN bypasses
    // — they need an unfiltered view to operate the platform.
    const filtered = passwords.filter((p) => {
      if (p.restrictedToUserIds.length === 0) return true;
      if (options.actor.role === 'SUPER_ADMIN') return true;
      return p.restrictedToUserIds.includes(options.actor.id);
    });

    if (filtered.length === 0) return [];

    const companies = await this.prisma.company.findMany({
      where: {
        id: { in: Array.from(new Set(filtered.map((p) => p.companyId))) },
      },
      select: { id: true, name: true, slug: true },
    });
    const byCompany = new Map(companies.map((c) => [c.id, c] as const));

    const rows: PasswordExpiration[] = [];
    for (const p of filtered) {
      const co = byCompany.get(p.companyId);
      if (!co) continue;

      // Hard expiry — within the warn window or already past.
      if (p.expiresAt) {
        const daysUntil = Math.floor(
          (p.expiresAt.getTime() - now) / dayMs,
        );
        if (daysUntil <= DEFAULT_WARN_WITHIN_DAYS) {
          rows.push({
            kind: 'password',
            companyId: co.id,
            companyName: co.name,
            companySlug: co.slug,
            passwordId: p.id,
            passwordName: p.name,
            source: 'expiry',
            expiresAt: p.expiresAt.toISOString(),
            daysUntil,
            status: daysUntil < 0 ? 'EXPIRED' : 'WARNING',
          });
        }
      }

      // Rotation due — only when both fields are set. `dueAt` is the
      // wall-clock date by which the credential should have been
      // rotated; `daysUntil` is signed and negative once overdue.
      if (p.rotationReminderDays != null && p.lastRotatedAt) {
        const dueAt = new Date(
          p.lastRotatedAt.getTime() + p.rotationReminderDays * dayMs,
        );
        const daysUntil = Math.floor((dueAt.getTime() - now) / dayMs);
        if (daysUntil <= DEFAULT_WARN_WITHIN_DAYS) {
          rows.push({
            kind: 'password',
            companyId: co.id,
            companyName: co.name,
            companySlug: co.slug,
            passwordId: p.id,
            passwordName: p.name,
            source: 'rotation',
            expiresAt: dueAt.toISOString(),
            daysUntil,
            status: daysUntil < 0 ? 'EXPIRED' : 'WARNING',
          });
        }
      }
    }
    return rows;
  }
}
