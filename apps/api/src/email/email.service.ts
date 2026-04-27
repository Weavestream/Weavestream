import { BadRequestException, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { TestEmailSettingsInput } from '@weavestream/shared';
import { EmailNotConfiguredError, EmailSettingsService } from './email-settings.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';

@Injectable()
export class EmailService {
  constructor(
    private readonly settings: EmailSettingsService,
    private readonly audit: AuditLogService,
  ) {}

  async send(input: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void> {
    const config = await this.settings.getSendConfig();
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secureMode === 'TLS',
      requireTLS: config.secureMode === 'STARTTLS',
      ignoreTLS: config.secureMode === 'NONE',
      auth: config.username
        ? { user: config.username, pass: config.password ?? '' }
        : undefined,
    });

    await transport.sendMail({
      from: {
        name: config.fromName ?? 'Weavestream',
        address: config.fromEmail,
      },
      replyTo: config.replyTo ?? undefined,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
  }

  async sendTest(
    actor: AuthedUser,
    input: TestEmailSettingsInput,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const subject = input.subject ?? 'Weavestream test email';
    let success = false;
    let error: string | null = null;

    try {
      await this.send({
        to: input.recipient,
        subject,
        text:
          'This is a test email from Weavestream. If you received it, SMTP is configured correctly.',
        html:
          '<p>This is a test email from Weavestream.</p><p>If you received it, SMTP is configured correctly.</p>',
      });
      success = true;
      return { ok: true };
    } catch (err) {
      error = messageOf(err);
      if (err instanceof EmailNotConfiguredError) throw err;
      throw new BadRequestException(`Test email failed: ${error}`);
    } finally {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.settings.emailTest,
        entityType: 'EmailSetting',
        entityId: 'singleton',
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          recipient: input.recipient,
          success,
          error,
        },
      });
    }
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Unknown SMTP error';
}
