import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  MICROSOFT_REPORT_SETTING,
  type MicrosoftReportNames,
  type MicrosoftReportNamesAction,
} from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import {
  IntegrationSecretEncryptionService,
  integrationConnectionSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationsService } from '../integrations.service.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import type { RequestMeta } from '../../common/request-meta.js';
import type { IntegrationContext } from '../drivers/integration-driver.js';
import { DriverAuthError, DriverRateLimitError } from '../drivers/integration-driver.js';
import { parseStoredAdminConsent, type StoredAdminConsent } from '../oauth/oauth-token.js';
import {
  REPORT_SETTINGS_WRITE,
  canReadReportSettings,
  readReportConcealment,
} from '../drivers/microsoft-365/microsoft-365.graph.js';
import { writeReportConcealment } from '../drivers/microsoft-365/microsoft-365.report-settings.js';

const DRIVER = 'microsoft-365';

export const REPORT_NAMES_READ_ERROR =
  `Weavestream could not read "${MICROSOFT_REPORT_SETTING.label}" for this tenant. Run Check setup, then try again.`;

export const REPORT_NAMES_NOT_READABLE =
  `Weavestream cannot read "${MICROSOFT_REPORT_SETTING.label}": the optional ReportSettings.Read.All is not granted in this tenant. Check it in the Microsoft 365 admin center.`;

export const REPORT_NAMES_NOT_CHANGEABLE =
  'This tenant did not grant the optional ReportSettings.ReadWrite.All, so Weavestream cannot change the setting. Change it by hand in the Microsoft 365 admin center (steps on this page).';

const CONNECTION_CHANGED = 'The Microsoft connection changed while saving. Reload the page and choose again.';

function canChange(consent: StoredAdminConsent): boolean {
  return consent.grantedRoles.includes(REPORT_SETTINGS_WRITE);
}

function readErrorOf(consent: StoredAdminConsent): string {
  return canReadReportSettings(consent.grantedRoles) ? REPORT_NAMES_READ_ERROR : REPORT_NAMES_NOT_READABLE;
}

/** "On (names hidden)" / "Off (real names shown)" for a displayConcealedNames value. */
export function settingState(concealed: boolean): string {
  return concealed ? 'On (names hidden)' : 'Off (real names shown)';
}

/**
 * The admin's choice about the tenant setting "Conceal user, group, and
 * site names in all reports" (Microsoft 365 admin center > Settings > Org
 * settings > Services > Reports; Graph adminReportSettings
 * .displayConcealedNames). Weavestream reads it before asking, and only
 * changes it on an explicit `show` (turn it off) or `conceal` (turn it back
 * on). `keep` records the choice and changes nothing. Every action is
 * audited with the value before and after; the stored choice lives in the
 * encrypted connection secret of that tenant.
 */
@Injectable()
export class MicrosoftReportNamesService {
  private readonly logger = new Logger(MicrosoftReportNamesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
  ) {}

  /** Current tenant value (read live) and the stored choice. */
  async status(integrationId: string, connectionId: string): Promise<MicrosoftReportNames> {
    const { ctx, consent } = await this.load(integrationId, connectionId);
    const concealed = await this.read(ctx, integrationId, consent);
    return {
      concealed,
      choice: consent.reportNames ?? null,
      readError: concealed === null ? readErrorOf(consent) : null,
      canChange: canChange(consent),
    };
  }

  async apply(
    actor: AuthedUser,
    integrationId: string,
    connectionId: string,
    input: MicrosoftReportNamesAction,
    meta: RequestMeta,
  ): Promise<MicrosoftReportNames> {
    const { ctx, consent } = await this.load(integrationId, connectionId);
    const auditBase = {
      actorId: actor.id,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    const detail = {
      connectionId,
      tenantId: consent.tenantId,
      setting: MICROSOFT_REPORT_SETTING.label,
      path: MICROSOFT_REPORT_SETTING.path,
      graphProperty: 'displayConcealedNames',
      action: input.action,
    };

    // Read before any change, so the audit row and the answer state the real "before".
    const before = await this.read(ctx, integrationId, consent);
    if (input.action === 'keep') {
      // Nothing changes, so the stored choice records what the tenant shows.
      const kept = before === false ? 'shown' : 'hidden';
      await this.storeChoice(integrationId, connectionId, consent, kept);
      await this.audit.log({
        ...auditBase,
        action: AUDIT_ACTIONS.integration.microsoftReportNames,
        before: { choice: consent.reportNames ?? null, displayConcealedNames: before },
        after: { ...detail, choice: kept, displayConcealedNames: before, changed: false },
      });
      return {
        concealed: before,
        choice: kept,
        readError: before === null ? readErrorOf(consent) : null,
        canChange: canChange(consent),
        message: `Nothing was changed in the tenant. "${MICROSOFT_REPORT_SETTING.label}" stays ${before === null ? 'as it is' : settingState(before)}.`,
      };
    }

    const conceal = input.action === 'conceal';
    const choice = conceal ? 'hidden' : 'shown';
    if (!canChange(consent)) {
      // Optional permission not granted: never attempt the PATCH.
      await this.audit.log({
        ...auditBase,
        action: AUDIT_ACTIONS.integration.microsoftReportNamesFailed,
        before: { displayConcealedNames: before },
        after: { ...detail, reason: 'not_granted' },
      });
      throw new BadRequestException(REPORT_NAMES_NOT_CHANGEABLE);
    }
    if (before === null) {
      await this.audit.log({
        ...auditBase,
        action: AUDIT_ACTIONS.integration.microsoftReportNamesFailed,
        before: null,
        after: { ...detail, reason: 'read_failed' },
      });
      throw new BadRequestException(REPORT_NAMES_READ_ERROR);
    }
    let changed = false;
    if (before !== conceal) {
      try {
        await writeReportConcealment(ctx, conceal);
        changed = true;
      } catch (e) {
        const reason = e instanceof DriverRateLimitError ? 'rate_limited' : e instanceof DriverAuthError ? 'forbidden' : 'provider_error';
        this.logger.warn({ err: (e as Error).message, integrationId, reason }, 'Report setting change failed');
        await this.audit.log({
          ...auditBase,
          action: AUDIT_ACTIONS.integration.microsoftReportNamesFailed,
          before: { displayConcealedNames: before },
          after: { ...detail, reason },
        });
        throw new BadRequestException(
          e instanceof DriverAuthError || e instanceof DriverRateLimitError
            ? e.message
            : 'Microsoft did not accept the change. Try again later.',
        );
      }
    }
    const changeAudit = (choiceStored: boolean) =>
      this.audit.log({
        ...auditBase,
        action: AUDIT_ACTIONS.integration.microsoftReportNames,
        before: { choice: consent.reportNames ?? null, displayConcealedNames: before },
        after: { ...detail, choice, displayConcealedNames: conceal, changed, ...(choiceStored ? {} : { choiceStored: false }) },
      });
    try {
      await this.storeChoice(integrationId, connectionId, consent, choice);
    } catch (e) {
      // The tenant may already have changed: that change is audited even when the choice is not stored.
      await changeAudit(false);
      throw e;
    }
    await changeAudit(true);
    const state = settingState(conceal);
    return {
      concealed: conceal,
      choice,
      readError: null,
      canChange: true,
      message: changed
        ? `Done: "${MICROSOFT_REPORT_SETTING.label}" is now ${state} for this tenant. Microsoft applies it within a few minutes; the next sync uses it.`
        : `"${MICROSOFT_REPORT_SETTING.label}" was already ${state}; nothing was changed.`,
    };
  }

  private async load(integrationId: string, connectionId: string): Promise<{ ctx: IntegrationContext; consent: StoredAdminConsent }> {
    const loaded = await this.integrations.loadDriverContext(integrationId, { connectionId });
    if (loaded.driver !== DRIVER) throw new BadRequestException('This integration is not Microsoft 365.');
    const consent = parseStoredAdminConsent(loaded.secret);
    if (!consent) throw new BadRequestException('Connect with Microsoft first.');
    return {
      consent,
      ctx: {
        config: loaded.config,
        secret: loaded.secret,
        oauthClient: loaded.oauthClient,
        connectionId: loaded.connectionId,
        credentialVersion: loaded.credentialVersion,
        integrationId,
        http: {
          timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
          maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
          backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
        },
        correlationId: randomUUID(),
      },
    };
  }

  /** Null when the setting cannot be read (permission missing, Microsoft unreachable). */
  private async read(ctx: IntegrationContext, integrationId: string, consent: StoredAdminConsent): Promise<boolean | null> {
    if (!canReadReportSettings(consent.grantedRoles)) return null;
    try {
      return await readReportConcealment(ctx);
    } catch (e) {
      this.logger.warn({ err: (e as Error).message, integrationId }, 'Reading the report setting failed');
      return null;
    }
  }

  private async storeChoice(
    integrationId: string,
    connectionId: string,
    consent: StoredAdminConsent,
    reportNames: 'shown' | 'hidden',
  ): Promise<void> {
    // Merge into the full stored object: the parsed consent drops fields this schema does not know.
    // A reconnect while the Graph calls ran must not be overwritten with the old consent.
    const aad = integrationConnectionSecretAad(integrationId, connectionId);
    const row = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, integrationId },
      select: { secretCiphertext: true },
    });
    let raw: unknown = null;
    try {
      raw = row ? JSON.parse(this.crypto.decrypt(row.secretCiphertext, aad)) : null;
    } catch (e) {
      this.logger.error({ err: (e as Error).message, integrationId, connectionId }, 'failed to decrypt connection secret');
    }
    const current = parseStoredAdminConsent(raw);
    if (!row || !current || current.tenantId !== consent.tenantId || current.consentedAt !== consent.consentedAt) {
      throw new ConflictException(CONNECTION_CHANGED);
    }
    const ciphertext = this.crypto.encrypt(JSON.stringify({ ...(raw as Record<string, unknown>), reportNames }), aad);
    // Compare-and-set on the ciphertext just read: a reconnect landing in between updates no row.
    const { count } = await this.prisma.integrationConnection.updateMany({
      where: { id: connectionId, integrationId, secretCiphertext: row.secretCiphertext },
      data: { secretCiphertext: ciphertext },
    });
    if (count !== 1) throw new ConflictException(CONNECTION_CHANGED);
  }
}
