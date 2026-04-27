import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type {
  EmailSettings,
  SmtpSecurityMode,
  UpdateEmailSettingsInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { SmtpSecretEncryptionService } from '../crypto/smtp-secret-encryption.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';

const SINGLETON_ID = 'singleton';

@Injectable()
export class EmailSettingsService {
  private static readonly CACHE_TTL_MS = 5_000;
  private cache: { value: EmailSettingRow; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly crypto: SmtpSecretEncryptionService,
  ) {}

  async get(): Promise<EmailSettings> {
    return toDto(await this.loadOrSeed());
  }

  async update(
    actor: AuthedUser,
    input: UpdateEmailSettingsInput,
    meta: RequestMeta,
  ): Promise<EmailSettings> {
    const before = await this.loadOrSeed();
    const data: Record<string, unknown> = { updatedBy: actor.id };

    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.host !== undefined) data.host = input.host;
    if (input.port !== undefined) data.port = input.port;
    if (input.secureMode !== undefined) data.secureMode = input.secureMode;
    if (input.username !== undefined) data.username = input.username;
    if (input.fromName !== undefined) data.fromName = input.fromName;
    if (input.fromEmail !== undefined) data.fromEmail = input.fromEmail;
    if (input.replyTo !== undefined) data.replyTo = input.replyTo;
    if (input.clearPassword) data.passwordCiphertext = null;
    if (input.password !== undefined) {
      data.passwordCiphertext = this.crypto.encrypt(input.password);
    }

    const after = await this.prisma.emailSetting.update({
      where: { id: SINGLETON_ID },
      data,
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.settings.emailUpdate,
      entityType: 'EmailSetting',
      entityId: SINGLETON_ID,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: stripForAudit(before),
      after: stripForAudit(after),
    });

    this.cache = null;
    return toDto(after);
  }

  async getSendConfig(): Promise<EmailSendConfig> {
    const row = await this.loadOrSeed();
    if (!row.enabled) throw new EmailNotConfiguredError('Email sending is disabled.');
    if (!row.host || !row.port || !row.fromEmail) {
      throw new EmailNotConfiguredError(
        'SMTP host, port, and from address are required before email can be sent.',
      );
    }

    let password: string | null = null;
    if (row.passwordCiphertext) {
      try {
        password = this.crypto.decrypt(row.passwordCiphertext);
      } catch {
        throw new ConflictException(
          'Stored SMTP password could not be decrypted. Save the password again.',
        );
      }
    }

    if (row.username && !password) {
      throw new EmailNotConfiguredError(
        'SMTP password is required when a username is configured.',
      );
    }

    return {
      host: row.host,
      port: row.port,
      secureMode: row.secureMode,
      username: row.username,
      password,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      replyTo: row.replyTo,
    };
  }

  private async loadOrSeed(): Promise<EmailSettingRow> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    const existing = await this.prisma.emailSetting.findUnique({
      where: { id: SINGLETON_ID },
    });
    const row =
      existing ??
      (await this.prisma.emailSetting.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID },
        update: {},
      }));

    this.cache = {
      value: row,
      expiresAt: now + EmailSettingsService.CACHE_TTL_MS,
    };
    return row;
  }
}

export class EmailNotConfiguredError extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}

export interface EmailSendConfig {
  host: string;
  port: number;
  secureMode: SmtpSecurityMode;
  username: string | null;
  password: string | null;
  fromName: string | null;
  fromEmail: string;
  replyTo: string | null;
}

type EmailSettingRow = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  secureMode: SmtpSecurityMode;
  username: string | null;
  passwordCiphertext: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  updatedAt: Date;
};

function toDto(row: EmailSettingRow): EmailSettings {
  return {
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    secureMode: row.secureMode,
    username: row.username,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    passwordConfigured: Boolean(row.passwordCiphertext),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stripForAudit(row: EmailSettingRow) {
  return {
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    secureMode: row.secureMode,
    username: row.username,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    passwordConfigured: Boolean(row.passwordCiphertext),
  };
}
